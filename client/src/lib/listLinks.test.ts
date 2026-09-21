/**
 * Dashboard counts link to the list that holds their rows. Both ends are in
 * listLinks.ts, and these tests hold them to each other: what a dashboard
 * writes is exactly what the page reads.
 */
import { describe, it, expect } from "vitest";
import {
  EXCEPTION_LIST_STATUSES,
  TRANSACTION_LIST_STATUSES,
  channelFromSearch,
  exceptionsHref,
  statusFromSearch,
  transactionsHref,
} from "./listLinks";
import { rangeFromSearch } from "./dateRange";

const search = (href: string) => href.slice(href.indexOf("?"));

describe("when a dashboard links an exception count", () => {
  it("should open on every date, because every dashboard counts all-time", () => {
    // Without the range the page opens on today and shows a fraction of the
    // count — the "1 open exception, empty page" report.
    for (const status of [undefined, ...EXCEPTION_LIST_STATUSES]) {
      const href = exceptionsHref(status);
      expect(href.startsWith("/exceptions?")).toBe(true);
      expect(rangeFromSearch(search(href))).toEqual({ from: "", to: "" });
    }
  });

  it("should open on the status it counted", () => {
    expect(statusFromSearch(search(exceptionsHref("open")), EXCEPTION_LIST_STATUSES)).toBe("open");
    expect(statusFromSearch(search(exceptionsHref("in_review")), EXCEPTION_LIST_STATUSES)).toBe("in_review");
    expect(statusFromSearch(search(exceptionsHref()), EXCEPTION_LIST_STATUSES)).toBeUndefined();
  });
});

describe("when a dashboard links a transaction count", () => {
  it("should carry the status and channel it counted, and no date range", () => {
    const href = transactionsHref({ status: "unmatched", channelId: 7 });
    expect(statusFromSearch(search(href), TRANSACTION_LIST_STATUSES)).toBe("unmatched");
    expect(channelFromSearch(search(href))).toBe(7);
    // The page already opens on every date; pinning a range would narrow it.
    expect(rangeFromSearch(search(href))).toBeNull();
  });

  it("should be the bare list when it counts everything", () => {
    expect(transactionsHref()).toBe("/transactions");
    expect(transactionsHref({ channelId: null })).toBe("/transactions");
  });
});

describe("when a page reads a link it did not write", () => {
  it("should drop a status it does not offer rather than filter by it", () => {
    // Sent to the server, an unknown status matches nothing and renders an
    // empty list that looks like a real answer.
    expect(statusFromSearch("?status=bogus", EXCEPTION_LIST_STATUSES)).toBeUndefined();
    expect(statusFromSearch("?status=manually_matched", TRANSACTION_LIST_STATUSES)).toBeUndefined();
  });

  it("should accept only a positive whole channel id", () => {
    for (const v of ["0", "-3", "1.5", "7abc", ""]) {
      expect(channelFromSearch(`?channelId=${v}`), v).toBeUndefined();
    }
    expect(channelFromSearch("?channelId=12")).toBe(12);
  });
});
