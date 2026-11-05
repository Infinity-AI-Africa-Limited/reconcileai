/**
 * The owner is told about every open SHOPLINE GDPR request before SHOPLINE's
 * 30-day deadline: counted from the requests table, reported as counts and
 * dates only. The SQL count itself is proven on real MySQL in
 * gdprDeadlines.db.test.ts.
 */
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { sql, type SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slConnectorGdprRequests } from "../../../drizzle/connector_schema";
import { scriptedDb } from "../shopify/scriptedDb.testkit";
import {
  checkShoplineGdprDeadlines,
  describeOpenShoplineGdprRequests,
  reportOpenShoplineGdprRequests,
  type OpenShoplineGdprRequests,
} from "./gdprDeadlines";

const REQUESTS = "sl_connector_gdpr_requests";
const NOW = new Date("2026-11-04T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;

function open(overrides: Partial<OpenShoplineGdprRequests> = {}): OpenShoplineGdprRequests {
  return { requests: 1, oldestReceivedAt: new Date(NOW.getTime() - 5 * DAY), overdue: 0, ...overrides };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("when the open requests are counted", () => {
  it("should count only requests still open, across every tenant", async () => {
    const fake = scriptedDb({ select: { [REQUESTS]: [[{ requests: 0, oldestReceivedAt: null, overdue: null }]] } });
    await checkShoplineGdprDeadlines({ db: fake.db as never, now: () => NOW, notify: vi.fn() });

    const select = fake.ops.find((op) => op.kind === "select" && op.table === REQUESTS);
    expect(select?.where?.sql).toBe("`sl_connector_gdpr_requests`.`status` = ?");
    expect(select?.where?.params).toEqual(["received"]);
    expect(select?.fields).toEqual(["requests", "oldestReceivedAt", "overdue"]);
  });

  it("should encode the overdue cutoff in the column's UTC form", () => {
    const cutoff = new Date(NOW.getTime() - 30 * DAY);
    const rendered = new MySqlDialect().sqlToQuery(sql`${sql.param(cutoff, slConnectorGdprRequests.receivedAt)}` as SQL);
    expect(rendered.params).toEqual(["2026-10-05 12:00:00.000"]);
  });
});

describe("when no request is open", () => {
  it("should neither log nor email", async () => {
    const notify = vi.fn();
    const fake = scriptedDb({ select: { [REQUESTS]: [[{ requests: 0, oldestReceivedAt: null, overdue: null }]] } });

    await expect(checkShoplineGdprDeadlines({ db: fake.db as never, now: () => NOW, notify })).resolves.toEqual({
      requests: 0,
      overdue: 0,
      notified: false,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("when requests are open", () => {
  const row = { requests: 2, oldestReceivedAt: new Date(NOW.getTime() - 31 * DAY), overdue: 1 };

  it("should log a fixed code with counts only, and email the owner", async () => {
    const notify = vi.fn().mockResolvedValue(true);
    const fake = scriptedDb({ select: { [REQUESTS]: [[row]] } });

    await expect(checkShoplineGdprDeadlines({ db: fake.db as never, now: () => NOW, notify })).resolves.toEqual({
      requests: 2,
      overdue: 1,
      notified: true,
    });
    expect(console.error).toHaveBeenCalledWith(expect.any(String), {
      code: "shopline_gdpr_overdue",
      requests: 2,
      overdue: 1,
    });
    expect(notify).toHaveBeenCalledWith(describeOpenShoplineGdprRequests(row, NOW));
  });

  it("should report the request as checked, not notified, when the email cannot be sent", async () => {
    const notify = vi.fn().mockRejectedValue(new Error("email down"));
    const fake = scriptedDb({ select: { [REQUESTS]: [[row]] } });

    await expect(checkShoplineGdprDeadlines({ db: fake.db as never, now: () => NOW, notify })).resolves.toMatchObject({
      notified: false,
    });
  });
});

describe("when the owner's message is written", () => {
  it("should give the oldest request's due date and the days left", () => {
    const message = describeOpenShoplineGdprRequests(open({ oldestReceivedAt: new Date(NOW.getTime() - 5 * DAY) }), NOW);
    expect(message.title).toBe("SHOPLINE GDPR requests need action: 1 open");
    expect(message.content).toContain("received 2026-10-30, and is due by 2026-11-29 (25 days left)");
    expect(message.content).toContain("docs/security/SHOPLINE_SHOP_ERASURE.md");
  });

  it("should lead with the overdue count once the deadline has passed", () => {
    const message = describeOpenShoplineGdprRequests(
      open({ requests: 3, overdue: 2, oldestReceivedAt: new Date(NOW.getTime() - 40 * DAY) }),
      NOW,
    );
    expect(message.title).toBe("SHOPLINE GDPR requests OVERDUE: 2 past SHOPLINE's 30-day deadline");
    expect(message.content).toContain("OVERDUE since 2026-10-25");
  });

  it("should carry no shop domain, subject hash or other request content", () => {
    const message = describeOpenShoplineGdprRequests(open(), NOW);
    expect(`${message.title}\n${message.content}`).not.toMatch(/myshopline\.com|[0-9a-f]{64}/i);
  });
});

describe("when the check runs as background work", () => {
  it("should log a failed count under its own code instead of throwing", async () => {
    const fake = scriptedDb({ select: { [REQUESTS]: [new Error("connection lost")] } });

    reportOpenShoplineGdprRequests({ db: fake.db as never, now: () => NOW, notify: vi.fn() });

    await vi.waitFor(() =>
      expect(console.error).toHaveBeenCalledWith(
        "[shopline-gdpr] could not check open GDPR requests",
        expect.objectContaining({ code: "shopline_gdpr_check_failed" }),
      ),
    );
  });
});
