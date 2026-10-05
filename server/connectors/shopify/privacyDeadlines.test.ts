import { MySqlDialect } from "drizzle-orm/mysql-core";
import { sql, type SQL } from "drizzle-orm";
import { shopifyPrivacyRequests } from "../../../drizzle/shopify_schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkShopifyPrivacyDeadlines,
  describeShopifyPrivacyAttention,
  resetShopifyPrivacyDeadlineThrottle,
  runShopifyPrivacyDeadlineCheck,
  SHOPIFY_PRIVACY_DEADLINE_CHECK_MS,
  SHOPIFY_PRIVACY_DEADLINE_NOTIFY_MS,
  type ShopifyPrivacyAttentionGroup,
} from "./privacyDeadlines";
import { scriptedDb } from "./scriptedDb.testkit";

const REQUESTS = "shopify_privacy_requests";
const NOW = new Date("2026-10-05T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;

function group(overrides: Partial<ShopifyPrivacyAttentionGroup> = {}): ShopifyPrivacyAttentionGroup {
  return {
    topic: "shop/redact",
    status: "manual_review",
    requests: 1,
    oldestReceivedAt: new Date(NOW.getTime() - 5 * DAY),
    overdue: 0,
    ...overrides,
  };
}

beforeEach(() => {
  resetShopifyPrivacyDeadlineThrottle();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("when the privacy requests are counted", () => {
  it("should ask for those needing a person, and those in flight for over three days, with Shopify's 30-day cutoff", async () => {
    const fake = scriptedDb({ select: { [REQUESTS]: [[]] } });
    await checkShopifyPrivacyDeadlines({ email: false }, { db: fake.db as never, now: () => NOW });

    const where = fake.ops.find((op) => op.kind === "select" && op.table === REQUESTS)?.where;
    expect(where?.params).toEqual([
      "manual_review", "blocked_dependency", "blocked_legal_retention", "failed_terminal", "failed",
      "received", "processing", "failed_retryable",
      // In flight since before this, encoded by the column (UTC), not by the process's timezone.
      "2026-10-02 12:00:00.000",
    ]);
  });

  it("should encode the overdue cutoff in the column's UTC form", () => {
    // The SUM(CASE…) fragment's parameter, rendered as the query would send it.
    const cutoff = new Date(NOW.getTime() - 30 * DAY);
    const rendered = new MySqlDialect().sqlToQuery(sql`${sql.param(cutoff, shopifyPrivacyRequests.receivedAt)}` as SQL);
    expect(rendered.params).toEqual(["2026-09-05 12:00:00.000"]);
  });
});

describe("when the owner's message is written", () => {
  it("should say nothing when no request needs attention", () => {
    expect(describeShopifyPrivacyAttention([], NOW)).toBeNull();
  });

  it("should give each group's count, oldest receipt and deadline, and lead with anything overdue", () => {
    const message = describeShopifyPrivacyAttention(
      [
        group({ topic: "customers/redact", status: "failed_terminal", requests: 2, oldestReceivedAt: new Date(NOW.getTime() - 40 * DAY), overdue: 1 }),
        group({ requests: 3 }),
      ],
      NOW,
    );
    expect(message?.title).toBe("Shopify privacy requests OVERDUE: 1 past Shopify's 30-day deadline");
    expect(message?.requests).toBe(5);
    expect(message?.content).toContain("- customers/redact · failed_terminal: 2 request(s); oldest received 2026-08-26, OVERDUE since 2026-09-25");
    expect(message?.content).toContain("- shop/redact · manual_review: 3 request(s); oldest received 2026-09-30, due by 2026-10-30 (25 days left)");
  });

  it("should carry counts and dates only — no field from any request", () => {
    const message = describeShopifyPrivacyAttention([group()], NOW);
    expect(message?.title).toBe("Shopify privacy requests need action: 1");
    expect(Object.keys(group()).sort()).toEqual(["oldestReceivedAt", "overdue", "requests", "status", "topic"]);
  });
});

describe("when the deadline check runs", () => {
  function due(rows: ShopifyPrivacyAttentionGroup[]) {
    return scriptedDb({ select: { [REQUESTS]: [rows, rows, rows, rows, rows] } });
  }

  it("should log the counts and email the owner when asked to", async () => {
    const notify = vi.fn(async () => true);
    const result = await checkShopifyPrivacyDeadlines({ email: true }, { db: due([group({ overdue: 1 })]).db as never, now: () => NOW, notify });
    expect(result).toEqual({ requests: 1, overdue: 1, notified: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), { code: "shopify_privacy_overdue", requests: 1, overdue: 1 });
  });

  it("should not fail when the email cannot be sent", async () => {
    const notify = vi.fn(async () => { throw new Error("resend down"); });
    const result = await checkShopifyPrivacyDeadlines({ email: true }, { db: due([group()]).db as never, now: () => NOW, notify });
    expect(result.notified).toBe(false);
  });

  it("should count at most hourly and email at most daily, retrying an email that was not sent", async () => {
    const fake = due([group()]);
    const notify = vi.fn(async () => true);
    let clock = NOW.getTime();
    const deps = { db: fake.db as never, now: () => new Date(clock), notify };

    await runShopifyPrivacyDeadlineCheck(deps);
    expect(notify).toHaveBeenCalledTimes(1);

    clock += SHOPIFY_PRIVACY_DEADLINE_CHECK_MS - 1;
    await runShopifyPrivacyDeadlineCheck(deps); // inside the hour: not even counted
    expect(fake.ops.filter((op) => op.table === REQUESTS)).toHaveLength(1);

    clock += 1;
    await runShopifyPrivacyDeadlineCheck(deps); // counted again, but no second email today
    expect(fake.ops.filter((op) => op.table === REQUESTS)).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(1);

    clock = NOW.getTime() + SHOPIFY_PRIVACY_DEADLINE_NOTIFY_MS;
    notify.mockResolvedValueOnce(false); // the day's email fails…
    await runShopifyPrivacyDeadlineCheck(deps);
    clock += SHOPIFY_PRIVACY_DEADLINE_CHECK_MS;
    await runShopifyPrivacyDeadlineCheck(deps); // …and is retried at the next hourly check
    expect(notify).toHaveBeenCalledTimes(3);
  });
});
