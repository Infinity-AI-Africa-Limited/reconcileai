/**
 * The public Privacy, Terms and Support pages make promises a merchant (and a
 * Shopify reviewer) will rely on. Each promise below is pinned to the code that
 * keeps it, so a change to the behaviour fails CI until the page changes too.
 *
 * Greptile #199 found two pages describing the product inaccurately: the Terms
 * said every Shopify privacy request restricts access (a customer data request
 * restricts nothing), and Support called two optional settlement columns
 * required. Both were written from intent, not from the code. This file is the
 * code side of that check, for the claims that can be checked mechanically.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SETTLEMENT_MAPPING_FIELDS } from "../client/src/lib/shopifySettlementMapping";

const ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

const privacy = read("client/src/pages/Privacy.tsx");
const terms = read("client/src/pages/Terms.tsx");
const support = read("client/src/pages/Support.tsx");
const pages = { privacy, terms, support };

/** The page's visible prose: JSX tags removed, whitespace collapsed. */
const prose = (source: string) =>
  source
    .replace(/<[^>]+>/g, " ")
    .replace(/\{" "\}/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

describe("when the public pages describe Shopify access", () => {
  it("should name exactly the scopes the app configuration requests", () => {
    const toml = read("shopify.app.toml");
    const configured = /^scopes\s*=\s*"([^"]*)"/m.exec(toml)?.[1];
    expect(configured, "shopify.app.toml must declare its scopes").toBeDefined();
    const scopes = configured!.split(",").map((scope) => scope.trim()).filter(Boolean);
    expect(scopes).toEqual(["read_orders"]);

    // Every scope a page names must be one the app requests, and each page that
    // states the permission must name the requested one.
    for (const [name, source] of Object.entries(pages)) {
      const named = [...source.matchAll(/<code>((?:read|write)_[a-z_]+)<\/code>/g)].map((match) => match[1]);
      for (const scope of named) expect(scopes, `${name} names ${scope}`).toContain(scope);
    }
    for (const source of [privacy, terms, support]) expect(source).toContain("<code>read_orders</code>");
  });
});

describe("when the support page lists what a settlement export needs", () => {
  it("should call required exactly the columns the importer requires, and the rest optional", () => {
    const required = SETTLEMENT_MAPPING_FIELDS.filter((field) => field.required).map((field) => field.field);
    const optional = SETTLEMENT_MAPPING_FIELDS.filter((field) => !field.required).map((field) => field.field);
    // The page's wording is written for merchants; this is the mapping it describes.
    expect(required).toEqual(["orderRef", "amount"]);
    expect(optional).toEqual(expect.arrayContaining(["currency", "settledAt"]));

    const text = prose(support);
    expect(text).toMatch(/has an order reference and an amount/);
    expect(text).toMatch(/A currency and a settlement date are recommended but optional/);
  });
});

describe("when the policies describe Shopify's privacy requests", () => {
  it("should promise an access restriction only for uninstall and shop/redact", () => {
    const text = prose(terms);
    // The old clause tied every "valid Shopify privacy request" to restricted access.
    expect(text).not.toMatch(/privacy request,? ReconcileAI restricts/i);
    expect(text).toMatch(/customers\/data_request and customers\/redact \) do not end or restrict your access/);
  });

  it("should state the data-request export window the server enforces", () => {
    // Read from source rather than imported: the module pulls in the whole
    // privacy worker. The constant is a product of integer literals; anything
    // else fails here rather than being guessed at.
    const source = read("server/connectors/shopify/privacyCompletion.ts");
    const literal = /export const SHOPIFY_PRIVACY_ARTIFACT_TTL_MS = ([0-9_* ]+);/.exec(source)?.[1];
    expect(literal, "SHOPIFY_PRIVACY_ARTIFACT_TTL_MS must stay a product of integer literals").toBeDefined();
    const ttlMs = literal!.split("*").reduce((product, factor) => product * Number(factor.trim().replace(/_/g, "")), 1);
    const days = ttlMs / (24 * 60 * 60_000);
    expect(Number.isInteger(days)).toBe(true);
    expect(prose(privacy)).toContain(`download it for up to ${days} days`);
  });

  it("should qualify each automatic outcome by the cases the workers hold for a person", () => {
    // Greptile #199: the notice promised every data request an export, but the
    // worker blocks any order with reconciliation records (and an order with no
    // administrator to receive it), and creates no download. While the code
    // blocks, the page must say so; if a block is removed, update the notice.
    const completion = read("server/connectors/shopify/privacyCompletion.ts");
    expect(completion).toContain('"downstream_evidence_present"');
    expect(completion).toContain('"merchant_admin_unavailable"');
    const redaction = read("server/connectors/shopify/customerRedaction.ts");
    expect(redaction).toContain('"unsupported_transaction_footprint"');

    const text = prose(privacy);
    expect(text).toMatch(/for orders that have not yet been reconciled, we prepare an export/);
    expect(text).toMatch(/already has reconciliation records \(a match, an exception, or an anomaly review\), or no administrator can receive the export, our team handles the request manually/);
    expect(text).toMatch(/not in the minimised form Scope A writes, our team handles the request manually/);
  });

  it("should describe uninstall as deleting the Shopify credentials, as the webhook does", () => {
    const webhooks = read("server/connectors/shopify/webhooks.ts");
    const uninstall = webhooks.slice(webhooks.indexOf("if (topic === SHOPIFY_UNINSTALL_TOPIC)"));
    expect(uninstall.slice(0, 2_000)).toMatch(/\.delete\(shopifyConnectorTokens\)/);
    expect(prose(terms)).toMatch(/deletes its Shopify access credentials/);
  });
});

describe("when the privacy notice describes Scope A evidence retention", () => {
  it("should state the retention period the control enforces and every reason it keeps evidence", () => {
    // Read from source rather than imported: the module pulls in the database
    // layer. A hold added to the control fails here until the notice names it.
    const source = read("server/connectors/shopify/evidenceRetention.ts");
    const days = /export const SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS = (\d+);/.exec(source)?.[1];
    expect(days, "the retention period must stay an integer literal").toBeDefined();
    const holdsBody = source.slice(
      source.indexOf("  return {", source.indexOf("export function scopeAEvidenceHolds")),
      source.indexOf("function purgeable(")
    );
    const holds = [...holdsBody.matchAll(/^ {4}(\w+): /gm)].map((match) => match[1]);
    const named: Record<string, RegExp> = {
      investigation: /while an exception on it is open, while a governed review of it is in progress/,
      matchReview: /while a match or anomaly on it is awaiting review/,
      anomalyReview: /while a match or anomaly on it is awaiting review/,
      queuedRun: /while a reconciliation run that reads it is queued or running/,
      governedControl: /while a governed control relies on it/,
    };
    expect(holds.sort()).toEqual(Object.keys(named).sort());

    const text = prose(privacy);
    expect(text).toContain(`removed ${days} days after the latest of`);
    for (const hold of holds) expect(text, hold).toMatch(named[hold]!);
    // The two holds that are not per-record: the store's unanswered data
    // requests, and the pair rule that keeps a reconciled pair together.
    expect(source).toContain('eq(shopifyPrivacyRequests.topic, "customers/data_request")');
    expect(text).toMatch(/while a customer data request for your store is not yet answered/);
    expect(source).toContain("export function deletableAfterPairing");
    expect(text).toMatch(/A reconciled pair, such as an order and the settlement matched to it, is removed together/);
  });
});
