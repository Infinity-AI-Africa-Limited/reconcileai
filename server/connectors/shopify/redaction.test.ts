import { describe, expect, it } from "vitest";
import { admitShopifyShopRedaction } from "./redaction";
import { rowOf, scriptedDb } from "./scriptedDb.testkit";

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
const RUN_ID = "00000000-0000-4000-8000-000000000903";
/** The digest the legacy job was admitted with (pre-#160 raw hash). */
const LEGACY_HASH = "legacy-raw-sha256-digest";
/** The digest of the delivery arriving now (keyed since #160). */
const DELIVERY_HASH = "keyed-webhook-digest";

function legacyJob(status: string) {
  return { jobId: 903, runId: RUN_ID, privacyRequestId: null, requestHash: LEGACY_HASH, status };
}

async function admit(script: NonNullable<Parameters<typeof scriptedDb>[0]>, requestHash = DELIVERY_HASH) {
  const fake = scriptedDb({
    ...script,
    select: { [ORGANIZATIONS]: [[{ id: STORE.organizationId }]], [STORES]: [[{ id: STORE.id }]], ...script.select },
  });
  const result = await admitShopifyShopRedaction(fake.db as never, { store: STORE, requestHash, webhookId: "internal-test-webhook-id" });
  return { fake, result };
}

describe("when a delivery finds a job admitted before jobs carried their request", () => {
  it("should bind the request the JOB represents, found by the job's own digest, and queue only its handle", async () => {
    const { fake, result } = await admit({ select: { [JOBS]: [[legacyJob("redacting")]], [REQUESTS]: [[{ id: 904 }]] } });

    expect(result).toEqual({ jobId: 903, runId: RUN_ID, status: "duplicate" });
    // Greptile #161: looking the request up by the DELIVERY's digest bound the
    // job to the wrong request, and left its own request unhandled.
    const lookup = fake.ops.find((op) => op.kind === "select" && op.table === REQUESTS);
    expect(lookup?.where?.params).toEqual([42, 7, "shop/redact", LEGACY_HASH]);
    expect(lookup?.where?.params).not.toContain(DELIVERY_HASH);

    const bound = fake.writes("update", JOBS).at(-1);
    expect(bound?.data).toMatchObject({ privacyRequestId: 904, status: "admitted", lastCheckpoint: "legacy_request_bound" });
    expect(bound?.where?.sql).toMatch(/`privacyRequestId` is null/i);

    const outbox = fake.writes("insert", OUTBOX).at(-1);
    expect(outbox?.data).toEqual({ kind: "shop_redact", jobId: 903, status: "pending" });
    expect(JSON.stringify(outbox?.data)).not.toMatch(/organization|store|domain|hash|webhook/i);
    expect(fake.writes("update", STORES)).toEqual([]);
  });

  it("should park the job for review, without guessing or failing the webhook, when its own request cannot be found", async () => {
    const { fake } = await admit({ select: { [JOBS]: [[legacyJob("admitted")]], [REQUESTS]: [[]] } });

    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "manual_review",
      failureCode: "legacy_request_unresolved",
    });
    expect(fake.writes("update", JOBS).some((op) => rowOf(op)?.privacyRequestId !== undefined)).toBe(false);
    expect(fake.writes("insert", OUTBOX)).toEqual([]);
  });

  it("should bind but not queue a legacy job that had already completed", async () => {
    const { fake } = await admit({ select: { [JOBS]: [[legacyJob("completed")]], [REQUESTS]: [[{ id: 904 }]] } });

    const bound = fake.writes("update", JOBS).at(-1);
    expect(bound?.data).toEqual({ privacyRequestId: 904, lastCheckpoint: "legacy_request_bound" });
    expect(fake.writes("insert", OUTBOX)).toEqual([]);
  });
});

describe("when a delivery finds a job already bound to its request", () => {
  it("should not requeue a terminal report-only job", async () => {
    const { fake, result } = await admit(
      { select: { [JOBS]: [[{ jobId: 903, runId: RUN_ID, privacyRequestId: 904, requestHash: DELIVERY_HASH, status: "blocked_dependency" }]] } },
    );

    expect(result.status).toBe("duplicate");
    expect(fake.writes("insert", OUTBOX)).toEqual([]);
    expect(fake.writes("update", JOBS)).toEqual([]);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
  });

  it("should heal a missing queue intent for a job that still owes work", async () => {
    const { fake } = await admit(
      { select: { [JOBS]: [[{ jobId: 903, runId: RUN_ID, privacyRequestId: 904, requestHash: DELIVERY_HASH, status: "failed_retryable" }]] } },
    );

    expect(fake.writes("insert", OUTBOX).at(-1)?.data).toEqual({ kind: "shop_redact", jobId: 903, status: "pending" });
  });

  it("should settle a further delivery with a different digest against the existing job", async () => {
    const { fake } = await admit(
      { select: { [JOBS]: [[{ jobId: 903, runId: RUN_ID, privacyRequestId: 904, requestHash: LEGACY_HASH, status: "blocked_dependency" }]] } },
    );

    // Its request row has no job of its own; left `received`, nothing would ever run it.
    const settled = fake.writes("update", REQUESTS).at(-1);
    expect(settled?.data).toEqual({ status: "blocked_dependency", completionNote: "covered_by_existing_shop_redaction" });
    expect(settled?.where?.params).toEqual([42, 7, "shop/redact", DELIVERY_HASH, "received"]);
  });
});
