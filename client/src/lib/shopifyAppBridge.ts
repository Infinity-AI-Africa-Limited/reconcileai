import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../../server/routers";

export type ShopifyAppBridgeContext = {
  store: {
    shopDomain: string;
    displayName: string;
    currency: string | null;
  };
  sync: {
    lastSuccessfulAt: string | null;
    lastErrorCode: string | null;
  };
  capabilities: {
    scope: "read_orders";
    readOrders: boolean;
    manualSync: boolean;
    shopifyPayments: boolean;
    mutations: boolean;
  };
};

export type ShopifySyncReport = {
  success: boolean;
  window: { from: string; to: string };
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
};

export type ShopifySettlementField =
  | "orderRef"
  | "gatewayRef"
  | "amount"
  | "currency"
  | "settledAt"
  | "fee"
  | "description";

export type ShopifySettlementEvidenceRequest = {
  fileName: string;
  content: string;
  contentEncoding: "utf8" | "base64";
  sourceLabel: string;
  /** The merchant-confirmed mapping; omit on the first check to detect columns. */
  columnMapping?: Partial<Record<ShopifySettlementField, string>>;
  dryRun: boolean;
};

export type ShopifySettlementEvidenceDryRun = {
  committed: false;
  headers: string[];
  mapping: Partial<Record<ShopifySettlementField, string>>;
  missingRequired: ShopifySettlementField[];
  totalRows: number;
  parseErrors: string[];
};

export type ShopifySettlementEvidenceCommitted = {
  committed: true;
  mapping: Partial<Record<ShopifySettlementField, string>>;
  totalRows: number;
  imported: number;
  duplicates: number;
  failed: number;
  matchedCount: number;
  exceptionCount: number;
};

export type ShopifySettlementEvidenceResult =
  | ShopifySettlementEvidenceDryRun
  | ShopifySettlementEvidenceCommitted;

type ShopifyAppBridgeApi = {
  idToken: () => Promise<string>;
};

declare global {
  interface Window {
    shopify?: ShopifyAppBridgeApi;
  }
}

const APP_BRIDGE_SCRIPT = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
/** Records the script's outcome on the element, so a later caller need not have heard its events. */
const SCRIPT_STATE = "data-reconcileai-app-bridge";
const APP_BRIDGE_LOAD_TIMEOUT_MS = 10_000;
const APP_BRIDGE_POLL_MS = 50;
let bridgeReady: Promise<ShopifyAppBridgeApi> | null = null;

export class ShopifyAppHomeClientError extends Error {
  constructor(public readonly code: "CONFIGURATION_UNAVAILABLE" | "APP_BRIDGE_UNAVAILABLE" | "AUTHENTICATION_REQUIRED" | "STORE_ACTION_REQUIRED" | "ORDER_SYNC_REQUIRED" | "ACTIVE_ADMIN_REQUIRED" | "INVALID_REQUEST" | "SYNC_IN_PROGRESS" | "SERVICE_UNAVAILABLE") {
    super(code);
    this.name = "ShopifyAppHomeClientError";
  }
}

const MESSAGE_CODES: Record<string, ShopifyAppHomeClientError["code"]> = {
  authentication_required: "AUTHENTICATION_REQUIRED",
  sync_in_progress: "SYNC_IN_PROGRESS",
  order_sync_required: "ORDER_SYNC_REQUIRED",
  active_admin_required: "ACTIVE_ADMIN_REQUIRED",
  invalid_request: "INVALID_REQUEST",
  store_action_required: "STORE_ACTION_REQUIRED",
  configuration_unavailable: "CONFIGURATION_UNAVAILABLE",
  service_unavailable: "SERVICE_UNAVAILABLE",
};

/**
 * What a failed App Home call means for the merchant. The server answers with
 * stable machine codes as the error message (server/connectors/shopify/appHome.ts),
 * never free text; an input the schema refused is a BAD_REQUEST with no code of
 * ours. An App Bridge failure raised while attaching the token keeps its own code.
 */
export function appHomeErrorCode(error: unknown): ShopifyAppHomeClientError["code"] {
  if (error instanceof ShopifyAppHomeClientError) return error.code;
  if (error instanceof TRPCClientError) {
    if (error.cause instanceof ShopifyAppHomeClientError) return error.cause.code;
    const known = MESSAGE_CODES[error.message];
    if (known) return known;
    const shape = error.data as { code?: string } | undefined;
    if (shape?.code === "BAD_REQUEST") return "INVALID_REQUEST";
    if (shape?.code === "UNAUTHORIZED") return "AUTHENTICATION_REQUIRED";
  }
  return "SERVICE_UNAVAILABLE";
}

/**
 * The App Home's tRPC clients. The workspace authenticates with a Shopify App
 * Bridge ID token, requested afresh for every call and sent only as a header —
 * never stored, logged, or put in React state. `config` is the one public call:
 * it is what App Bridge needs before any token can exist.
 */
const publicClient = createTRPCClient<AppRouter>({
  links: [httpLink({ url: "/api/trpc", transformer: superjson })],
});
const embeddedClient = createTRPCClient<AppRouter>({
  links: [
    httpLink({
      url: "/api/trpc",
      transformer: superjson,
      async headers() {
        const bridge = await getShopifyAppBridge();
        return { authorization: `Bearer ${await bridge.idToken()}` };
      },
    }),
  ],
});

async function appHomeCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new ShopifyAppHomeClientError(appHomeErrorCode(error));
  }
}

function apiKeyMeta(apiKey: string): HTMLMetaElement {
  const existing = document.querySelector<HTMLMetaElement>('meta[name="shopify-api-key"]');
  if (existing) return existing;
  const meta = document.createElement("meta");
  meta.name = "shopify-api-key";
  meta.content = apiKey;
  document.head.prepend(meta);
  return meta;
}

function recordScriptState(script: HTMLScriptElement): void {
  script.addEventListener("load", () => script.setAttribute(SCRIPT_STATE, "loaded"), { once: true });
  script.addEventListener("error", () => script.setAttribute(SCRIPT_STATE, "failed"), { once: true });
}

/**
 * Settles on the script's load or error event, on App Bridge becoming usable,
 * or on a timeout — never on an event alone. An element that already loaded
 * (or failed) will not fire again, so waiting for its events could leave the
 * workspace on its spinner forever instead of showing an error and retry.
 */
function waitForScript(script: HTMLScriptElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: ShopifyAppHomeClientError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onLoad = () => finish();
    const onError = () => finish(new ShopifyAppHomeClientError("APP_BRIDGE_UNAVAILABLE"));
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    const poll = setInterval(() => {
      if (window.shopify?.idToken) finish();
    }, APP_BRIDGE_POLL_MS);
    const timer = setTimeout(
      () => finish(new ShopifyAppHomeClientError("APP_BRIDGE_UNAVAILABLE")),
      timeoutMs,
    );
  });
}

function loadScript(timeoutMs = APP_BRIDGE_LOAD_TIMEOUT_MS): Promise<void> {
  if (window.shopify?.idToken) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${APP_BRIDGE_SCRIPT}"]`);
  if (existing) {
    const state = existing.getAttribute(SCRIPT_STATE);
    // Loaded without App Bridge becoming usable: the caller reports it.
    if (state === "loaded") return Promise.resolve();
    // Still loading, or placed by someone else: wait, but not forever.
    if (state !== "failed") return waitForScript(existing, timeoutMs);
    // A failed script never retries by itself; replace it so "Try again" can.
    existing.remove();
  }
  const script = document.createElement("script");
  script.src = APP_BRIDGE_SCRIPT;
  script.async = true;
  recordScriptState(script);
  const ready = waitForScript(script, timeoutMs);
  document.head.appendChild(script);
  return ready;
}

/**
 * Loads the current Shopify App Bridge only in the App Home route. The API key
 * is public configuration; credentials and ID tokens never enter this module's
 * storage, URL, logs, or React state. The token is requested afresh per API call.
 */
export async function getShopifyAppBridge(): Promise<ShopifyAppBridgeApi> {
  if (!bridgeReady) {
    bridgeReady = (async () => {
      if (window.shopify?.idToken) return window.shopify;
      let apiKey: string;
      try {
        ({ apiKey } = await publicClient.shopifyAppHome.config.query());
      } catch {
        throw new ShopifyAppHomeClientError("CONFIGURATION_UNAVAILABLE");
      }
      apiKeyMeta(apiKey);
      await loadScript();
      if (!window.shopify?.idToken) throw new ShopifyAppHomeClientError("APP_BRIDGE_UNAVAILABLE");
      return window.shopify;
    })().catch((error) => {
      bridgeReady = null;
      throw error;
    });
  }
  return bridgeReady;
}

export async function loadShopifyAppHomeContext(): Promise<ShopifyAppBridgeContext> {
  return appHomeCall(() => embeddedClient.shopifyAppHome.context.query());
}

export async function triggerShopifyOrderSync(): Promise<ShopifySyncReport> {
  return appHomeCall(() => embeddedClient.shopifyAppHome.syncNow.mutate());
}

export async function submitShopifySettlementEvidence(
  input: ShopifySettlementEvidenceRequest,
): Promise<ShopifySettlementEvidenceResult> {
  return appHomeCall(() => embeddedClient.shopifyAppHome.importSettlementEvidence.mutate(input));
}

export function shopifyAppHomeErrorMessage(error: unknown): string {
  if (!(error instanceof ShopifyAppHomeClientError)) {
    return "ReconcileAI could not load this Shopify workspace. Please try again.";
  }
  switch (error.code) {
    case "CONFIGURATION_UNAVAILABLE":
      return "The Shopify connection is not configured for this environment yet. Please contact ReconcileAI support.";
    case "APP_BRIDGE_UNAVAILABLE":
      return "Shopify App Bridge could not load. Disable any ad blocker, refresh this App Home, and try again.";
    case "AUTHENTICATION_REQUIRED":
      return "Your Shopify session could not be verified. Refresh this App Home from Shopify Admin and try again.";
    case "STORE_ACTION_REQUIRED":
      return "This store needs to be reconnected before ReconcileAI can read order evidence.";
    case "ORDER_SYNC_REQUIRED":
      return "Sync Shopify order evidence once before importing settlement evidence.";
    case "ACTIVE_ADMIN_REQUIRED":
      return "An active ReconcileAI administrator for this store is required before evidence can be imported.";
    case "INVALID_REQUEST":
      return "ReconcileAI could not check this file. Confirm it is a supported CSV or Excel export under 10MB and try again.";
    case "SYNC_IN_PROGRESS":
      return "A reconciliation sync is already running for this store. Wait a moment, then refresh this page.";
    case "SERVICE_UNAVAILABLE":
      return "ReconcileAI is temporarily unavailable. Please try again shortly.";
  }
}

/** Test-only reset for deterministic module-level App Bridge loading. */
export function resetShopifyAppBridgeForTest(): void {
  bridgeReady = null;
}

/** Test-only access to the script loader with a short timeout. */
export function loadShopifyAppBridgeScriptForTest(timeoutMs: number): Promise<void> {
  return loadScript(timeoutMs);
}
