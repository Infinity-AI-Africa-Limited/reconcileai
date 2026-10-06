import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SHOPIFY_API_VERSION,
  SHOPIFY_ORDER_LED_SCOPES,
} from "../../../drizzle/shopify_schema";
import { SHOPIFY_ORDER_TRIGGER_TOPICS } from "./webhooks";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const config = fs.readFileSync(path.join(root, "shopify.app.toml"), "utf8");

function quotedValue(source: string, key: string): string | null {
  return (
    new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, "m").exec(source)?.[1] ?? null
  );
}

function blockArray(source: string, key: string): string[] {
  const match = new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map(entry => entry[1]);
}

function subscriptionBlocks(source: string): string[] {
  return source
    .split("[[webhooks.subscriptions]]")
    .slice(1)
    .map(block => block.split("[[webhooks.subscriptions]]")[0]);
}

describe("Shopify app configuration", () => {
  it("keeps the ReconcileAI Dev Store on the narrow embedded Scope A boundary", () => {
    expect(quotedValue(config, "name")).toBe("ReconcileAI Dev Store");
    expect(quotedValue(config, "application_url")).toBe(
      "https://www.reconcileaiafrica.com/shopify/app"
    );
    expect(config).toMatch(/^embedded\s*=\s*true\s*$/m);
    expect(quotedValue(config, "scopes")).toBe(
      SHOPIFY_ORDER_LED_SCOPES.join(",")
    );
    expect(config).toMatch(/^use_legacy_install_flow\s*=\s*true\s*$/m);
    expect(config).toContain(
      '"https://www.reconcileaiafrica.com/api/shopify/callback"'
    );
    expect(config).toMatch(
      /^automatically_update_urls_on_dev\s*=\s*false\s*$/m
    );

    expect(config).not.toMatch(/\bwrite_[a-z_]+\b/);
    expect(config).not.toMatch(/\bread_shopify_payments_[a-z_]+\b/);
    expect(config).not.toMatch(/\bshopify_payments\b/);
    expect(config).not.toMatch(/\bapp_proxy\b/);
  });

  it("subscribes every implemented order, uninstall, and mandatory privacy topic to the HMAC endpoint", () => {
    expect(quotedValue(config, "api_version")).toBe(SHOPIFY_API_VERSION);

    const blocks = subscriptionBlocks(config);
    expect(blocks).toHaveLength(2);
    expect(blockArray(blocks[0], "topics")).toEqual([
      ...SHOPIFY_ORDER_TRIGGER_TOPICS,
      "app/uninstalled",
    ]);
    expect(blockArray(blocks[1], "compliance_topics")).toEqual([
      "customers/data_request",
      "customers/redact",
      "shop/redact",
    ]);
    for (const block of blocks) {
      expect(quotedValue(block, "uri")).toBe(
        "https://www.reconcileaiafrica.com/api/webhooks/shopify"
      );
    }
  });
});
