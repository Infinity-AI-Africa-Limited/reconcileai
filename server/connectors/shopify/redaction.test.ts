import { describe, expect, it } from "vitest";
import { admitShopifyShopRedaction } from "./redaction";
import { scriptedDb } from "./scriptedDb.testkit";

const ORGANIZATIONS = "organizations";
const STORES = "shopify_connector_stores";
const JOBS = "shopify_shop_redaction_jobs";
const REQUESTS = "shopify_privacy_requests";
const OUTBOX = "shopify_privacy_queue_outbox";

const STORE = {
  id: 7,
  organizationId: 42,
  shopDomain: "scope-a-test.myshopify.com",
};

describe("Shopify shop-redact admission recovery", () => {
  it("backfills a legacy job from a verified redelivery and schedules only its internal handle", async () => {
    const fake = scriptedDb({
      select: {
        [ORGANIZATIONS]: [[{ id: STORE.organizationId }]],
        [STORES]: [[{ id: STORE.id }]],
        [JOBS]: [[{
          jobId: 903,
          runId: "00000000-0000-4000-8000-000000000903",
          privacyRequestId: null,
          status: "redacting",
        }]],
        [REQUESTS]: [[{ id: 904 }]],
      },
      update: { [JOBS]: [1] },
    });

    const result = await admitShopifyShopRedaction(fake.db as never, {
      store: STORE,
      requestHash: "keyed-webhook-digest",
      webhookId: "internal-test-webhook-id",
    });

    expect(result).toEqual({
      jobId: 903,
      runId: "00000000-0000-4000-8000-000000000903",
      status: "duplicate",
    });
    const backfill = fake.writes("update", JOBS).at(-1);
    expect(backfill?.data).toMatchObject({
      privacyRequestId: 904,
      status: "admitted",
      lastCheckpoint: "legacy_dispatch_backfilled",
      failureCode: null,
      leaseId: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
    });
    expect(backfill?.where?.params).toEqual(expect.arrayContaining([903, STORE.organizationId, STORE.id]));

    const outbox = fake.writes("insert", OUTBOX).at(-1);
    expect(outbox?.data).toEqual({ kind: "shop_redact", jobId: 903, status: "pending" });
    expect(JSON.stringify(outbox?.data)).not.toMatch(/organization|store|domain|hash|webhook/i);
    expect(outbox?.upsert).toBe(true);
    expect(fake.writes("update", STORES)).toEqual([]);
    expect(fake.writes("delete", STORES)).toEqual([]);
  });

  it("does not requeue a terminal report-only job on duplicate delivery", async () => {
    const fake = scriptedDb({
      select: {
        [ORGANIZATIONS]: [[{ id: STORE.organizationId }]],
        [STORES]: [[{ id: STORE.id }]],
        [JOBS]: [[{
          jobId: 903,
          runId: "00000000-0000-4000-8000-000000000903",
          privacyRequestId: 904,
          status: "blocked_dependency",
        }]],
      },
    });

    const result = await admitShopifyShopRedaction(fake.db as never, {
      store: STORE,
      requestHash: "keyed-webhook-digest",
      webhookId: "internal-test-webhook-id",
    });

    expect(result.status).toBe("duplicate");
    expect(fake.writes("insert", OUTBOX)).toEqual([]);
    expect(fake.writes("update", JOBS)).toEqual([]);
  });
});
