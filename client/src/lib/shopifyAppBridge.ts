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
  columnOverrides?: Partial<Record<ShopifySettlementField, string>>;
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
const CONFIG_PATH = "/api/shopify/app-home/config";
let bridgeReady: Promise<ShopifyAppBridgeApi> | null = null;

export class ShopifyAppHomeClientError extends Error {
  constructor(public readonly code: "CONFIGURATION_UNAVAILABLE" | "APP_BRIDGE_UNAVAILABLE" | "AUTHENTICATION_REQUIRED" | "STORE_ACTION_REQUIRED" | "ORDER_SYNC_REQUIRED" | "ACTIVE_ADMIN_REQUIRED" | "INVALID_REQUEST" | "SYNC_IN_PROGRESS" | "SERVICE_UNAVAILABLE") {
    super(code);
    this.name = "ShopifyAppHomeClientError";
  }
}

function apiErrorCode(status: number, body: unknown): ShopifyAppHomeClientError["code"] {
  const code = body && typeof body === "object" && "error" in body
    ? (body as { error?: { code?: unknown } }).error?.code
    : undefined;
  if (status === 401 || code === "authentication_required") return "AUTHENTICATION_REQUIRED";
  if (status === 409 || code === "sync_in_progress") return "SYNC_IN_PROGRESS";
  if (code === "order_sync_required") return "ORDER_SYNC_REQUIRED";
  if (status === 403 || code === "active_admin_required") return "ACTIVE_ADMIN_REQUIRED";
  if (status === 400 || code === "invalid_request") return "INVALID_REQUEST";
  if (status === 422 || code === "store_action_required") return "STORE_ACTION_REQUIRED";
  if (code === "configuration_unavailable") return "CONFIGURATION_UNAVAILABLE";
  return "SERVICE_UNAVAILABLE";
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
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

function loadScript(): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${APP_BRIDGE_SCRIPT}"]`);
  if (existing) {
    if (window.shopify?.idToken) return Promise.resolve();
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new ShopifyAppHomeClientError("APP_BRIDGE_UNAVAILABLE")), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = APP_BRIDGE_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new ShopifyAppHomeClientError("APP_BRIDGE_UNAVAILABLE"));
    document.head.appendChild(script);
  });
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
      const configResponse = await fetch(CONFIG_PATH, { credentials: "same-origin" });
      const config = await responseJson(configResponse);
      if (!configResponse.ok || !config || typeof config !== "object" || typeof (config as { apiKey?: unknown }).apiKey !== "string") {
        throw new ShopifyAppHomeClientError("CONFIGURATION_UNAVAILABLE");
      }
      apiKeyMeta((config as { apiKey: string }).apiKey);
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

async function appHomeFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const bridge = await getShopifyAppBridge();
  const token = await bridge.idToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = await responseJson(response);
  if (!response.ok) throw new ShopifyAppHomeClientError(apiErrorCode(response.status, body));
  return body;
}

export async function loadShopifyAppHomeContext(): Promise<ShopifyAppBridgeContext> {
  return appHomeFetch("/api/shopify/app-home/context") as Promise<ShopifyAppBridgeContext>;
}

export async function triggerShopifyOrderSync(): Promise<ShopifySyncReport> {
  return appHomeFetch("/api/shopify/app-home/sync", { method: "POST" }) as Promise<ShopifySyncReport>;
}

export async function submitShopifySettlementEvidence(
  input: ShopifySettlementEvidenceRequest,
): Promise<ShopifySettlementEvidenceResult> {
  return appHomeFetch("/api/shopify/app-home/settlement-evidence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }) as Promise<ShopifySettlementEvidenceResult>;
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
