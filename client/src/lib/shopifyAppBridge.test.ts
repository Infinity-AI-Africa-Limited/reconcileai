import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadShopifyAppBridgeScriptForTest,
  ShopifyAppHomeClientError,
} from "./shopifyAppBridge";

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
