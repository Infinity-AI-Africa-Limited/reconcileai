import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCClientError } from "@trpc/client";
import {
  appHomeErrorCode,
  initializeShopifyManagedInstall,
  loadShopifyAppBridgeScriptForTest,
  loadShopifyAppHomeContext,
  resetShopifyAppBridgeForTest,
  loadShopifyCases,
  loadShopifyCase,
  subscribeShopifyAuthRefusal,
  triggerShopifyOrderSync,
  ShopifyAppHomeClientError,
} from "./shopifyAppBridge";
import { createShopifyCaseReview } from "./shopifyCaseReview";

const APP_BRIDGE_SCRIPT = "https://cdn.shopify.com/shopifycloud/app-bridge.js";

/** Just enough of a <script> element for the loader: attributes and events. */
class FakeScript {
  src = "";
  async = false;
  private attributes = new Map<string, string>();
  private listeners: Array<{ type: string; listener: () => void; once: boolean }> = [];

  constructor(private readonly page: FakePage) {}

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }) {
    this.listeners.push({ type, listener, once: Boolean(options?.once) });
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners = this.listeners.filter((entry) => entry.type !== type || entry.listener !== listener);
  }
  remove() { this.page.scripts = this.page.scripts.filter((script) => script !== this); }
  fire(type: "load" | "error") {
    const matching = this.listeners.filter((entry) => entry.type === type);
    this.listeners = this.listeners.filter((entry) => entry.type !== type || !entry.once);
    for (const { listener } of matching) listener();
  }
}

class FakePage {
  scripts: FakeScript[] = [];
  window: { shopify?: { idToken: () => Promise<string> } } = {};
  document = {
    querySelector: (selector: string) =>
      selector === `script[src="${APP_BRIDGE_SCRIPT}"]`
        ? this.scripts.find((script) => script.src === APP_BRIDGE_SCRIPT) ?? null
        : null,
    createElement: () => new FakeScript(this),
    head: { appendChild: (script: FakeScript) => { this.scripts.push(script); } },
  };

  /** A tag already on the page whose events have come and gone. */
  addStaleScript(state?: "loaded" | "failed"): FakeScript {
    const script = new FakeScript(this);
    script.src = APP_BRIDGE_SCRIPT;
    if (state) script.setAttribute("data-reconcileai-app-bridge", state);
    this.scripts.push(script);
    return script;
  }
}

let page: FakePage;

beforeEach(() => {
  vi.useFakeTimers();
  page = new FakePage();
  vi.stubGlobal("window", page.window);
  vi.stubGlobal("document", page.document);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle<T>(promise: Promise<T>, advanceMs: number) {
  const outcome = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  return outcome;
}

describe("loading the App Bridge script", () => {
  describe("when the script is already on the page but its load event has passed", () => {
    it("should give up with an error the workspace can show, instead of waiting forever", async () => {
      page.addStaleScript();

      const outcome = await settle(loadShopifyAppBridgeScriptForTest(1_000), 1_000);

      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? null : outcome.error).toBeInstanceOf(ShopifyAppHomeClientError);
    });

    it("should resolve as soon as App Bridge becomes usable, without an event", async () => {
      page.addStaleScript();
      const loading = loadShopifyAppBridgeScriptForTest(1_000);
      page.window.shopify = { idToken: async () => "token" };

      await expect(settle(loading, 100)).resolves.toEqual({ ok: true, value: undefined });
    });
  });

  describe("when an earlier attempt's script failed", () => {
    it("should replace the failed tag so a retry can load it again", async () => {
      const failed = page.addStaleScript("failed");

      const loading = loadShopifyAppBridgeScriptForTest(1_000);
      expect(page.scripts).not.toContain(failed);
      expect(page.scripts).toHaveLength(1);
      page.scripts[0]?.fire("load");

      await expect(settle(loading, 0)).resolves.toEqual({ ok: true, value: undefined });
      expect(page.scripts[0]?.getAttribute("data-reconcileai-app-bridge")).toBe("loaded");
    });
  });

  describe("when the script is inserted by this page", () => {
    it("should record a failure on the tag and reject", async () => {
      const loading = loadShopifyAppBridgeScriptForTest(1_000);
      page.scripts[0]?.fire("error");

      const outcome = await settle(loading, 0);
      expect(outcome.ok).toBe(false);
      expect(page.scripts[0]?.getAttribute("data-reconcileai-app-bridge")).toBe("failed");
    });
  });
});

describe("when an App Home call fails", () => {
  const serverError = (message: string, code: string) =>
    TRPCClientError.from({ error: { message, code: -32600, data: { code, httpStatus: 400 } } });

  it("should read the server's stable code from the message", () => {
    expect(appHomeErrorCode(serverError("order_sync_required", "PRECONDITION_FAILED"))).toBe("ORDER_SYNC_REQUIRED");
    expect(appHomeErrorCode(serverError("store_action_required", "PRECONDITION_FAILED"))).toBe("STORE_ACTION_REQUIRED");
    expect(appHomeErrorCode(serverError("authentication_required", "UNAUTHORIZED"))).toBe("AUTHENTICATION_REQUIRED");
    expect(appHomeErrorCode(serverError("active_admin_required", "FORBIDDEN"))).toBe("ACTIVE_ADMIN_REQUIRED");
    expect(appHomeErrorCode(serverError("sync_in_progress", "CONFLICT"))).toBe("SYNC_IN_PROGRESS");
    expect(appHomeErrorCode(serverError("installation_in_progress", "CONFLICT"))).toBe("INSTALLATION_IN_PROGRESS");
    expect(appHomeErrorCode(serverError("required_permissions_not_granted", "PRECONDITION_FAILED"))).toBe("REQUIRED_PERMISSIONS_NOT_GRANTED");
  });

  it("should treat an input the schema refused as an invalid request", () => {
    expect(appHomeErrorCode(serverError("[{ \"code\": \"invalid_key\" }]", "BAD_REQUEST"))).toBe("INVALID_REQUEST");
  });

  it("should keep an App Bridge failure raised while attaching the token", () => {
    const wrapped = TRPCClientError.from(new ShopifyAppHomeClientError("APP_BRIDGE_UNAVAILABLE"));
    expect(appHomeErrorCode(wrapped)).toBe("APP_BRIDGE_UNAVAILABLE");
  });

  it("should call anything else an outage, never guess", () => {
    expect(appHomeErrorCode(new Error("network down"))).toBe("SERVICE_UNAVAILABLE");
    expect(appHomeErrorCode(serverError("something new", "INTERNAL_SERVER_ERROR"))).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("when the workspace calls its API", () => {
  it("should call the tRPC procedure with a fresh App Bridge token, and nothing else identifying", async () => {
    vi.useRealTimers();
    resetShopifyAppBridgeForTest();
    page.window.shopify = { idToken: vi.fn(async () => "id-token-1") };
    const view = {
      store: { shopDomain: "merchant.myshopify.com", displayName: "Merchant", currency: "USD" },
      sync: { lastSuccessfulAt: null, lastErrorCode: null },
      capabilities: { scope: "read_orders", readOrders: true, manualSync: true, shopifyPayments: false, mutations: false },
    };
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ result: { data: { json: view } } }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchStub);

    await expect(loadShopifyAppHomeContext()).resolves.toEqual(view);

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^\/api\/trpc\/shopifyAppHome\.context/);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer id-token-1");
    expect(url).not.toMatch(/organizationId|storeId/);
  });

  it("should initialize Shopify-managed installation with a fresh App Bridge token before loading a new workspace", async () => {
    vi.useRealTimers();
    resetShopifyAppBridgeForTest();
    page.window.shopify = { idToken: vi.fn(async () => "id-token-2") };
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ result: { data: { json: { status: "connected" } } } }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchStub);

    await expect(initializeShopifyManagedInstall()).resolves.toBeUndefined();

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^\/api\/trpc\/shopifyAppHome\.initialize/);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer id-token-2");
    expect(url).not.toMatch(/organizationId|storeId|id-token/);
  });
});

describe("when the embedded case API is called", () => {
  it("should acquire a fresh token for list, detail and on-demand refresh, only in the Authorization header", async () => {
    vi.useRealTimers(); resetShopifyAppBridgeForTest();
    let sequence = 0;
    page.window.shopify = { idToken: vi.fn(async () => `case-token-${++sequence}`) };
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ result: { data: { json: {} } } }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchStub);
    await loadShopifyCases({ status: "unresolved", page: 1 });
    await loadShopifyCase(7);
    await loadShopifyCases({ status: "open", page: 2 });
    expect(page.window.shopify.idToken).toHaveBeenCalledTimes(3);
    fetchStub.mock.calls.forEach((call, index) => {
      const [url, init] = call as unknown as [string, RequestInit];
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer case-token-${index + 1}`);
      expect(decodeURIComponent(url) + (init.body ?? "")).not.toMatch(/case-token|organizationId|storeId|channelId|userId|shopDomain|portalOrg/);
      expect(init.method).toBe("GET");
    });
    expect(decodeURIComponent((fetchStub.mock.calls[1] as unknown as [string])[0])).toContain('"caseId":7');
  });
  it("should clear case results when any embedded operation refuses authentication", async () => {
    vi.useRealTimers(); resetShopifyAppBridgeForTest();
    page.window.shopify = { idToken: async () => "synthetic-token" };
    const review = createShopifyCaseReview({ list: async () => ({ cases: [], total: 1, page: 1, pageSize: 20 }), detail: async () => { throw new Error("unused"); } });
    await review.refresh();
    const unsubscribe = subscribeShopifyAuthRefusal(review.refuseAuthentication);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { json: { message: "authentication_required", code: -32001, data: { code: "UNAUTHORIZED", httpStatus: 401 } } } }), { status: 401, headers: { "content-type": "application/json" } })));
    try {
      await expect(triggerShopifyOrderSync()).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
      expect(review.getSnapshot().list).toBeNull();
      expect(review.getSnapshot().error).toContain("Shopify Admin");
    } finally { unsubscribe(); review.dispose(); }
  });
  it("should preserve static not-found and unavailable without operational messages", () => {
    const serverError = (message: string) => TRPCClientError.from({ error: { message, code: -32600, data: { code: "NOT_FOUND", httpStatus: 404 } } });
    expect(appHomeErrorCode(serverError("not_found"))).toBe("NOT_FOUND");
    expect(appHomeErrorCode(serverError("unavailable"))).toBe("SERVICE_UNAVAILABLE");
    expect(appHomeErrorCode(serverError("RAW SQL private@example.invalid"))).toBe("SERVICE_UNAVAILABLE");
  });
});
