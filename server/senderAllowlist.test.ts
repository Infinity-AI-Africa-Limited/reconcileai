/**
 * Sender allow-list and attachment gating for email-forward ingestion.
 *
 * These two functions are the whole security model of Tier A beyond the webhook
 * signature. The failure modes they guard against are all "looks like it works":
 * an empty list quietly accepting the world, a suffix match accepting
 * evil-stripe.com, an attachment name walking out of its directory.
 */
import { describe, it, expect } from "vitest";
import {
  isSenderAllowed,
  normaliseSender,
  parseAllowlist,
  isIngestibleAttachment,
} from "./ingest/senderAllowlist";

describe("normaliseSender", () => {
  it.each([
    ["payouts@stripe.com", "payouts@stripe.com"],
    ["Stripe Payouts <payouts@stripe.com>", "payouts@stripe.com"],
    ["<payouts@stripe.com>", "payouts@stripe.com"],
    ["  PAYOUTS@Stripe.COM  ", "payouts@stripe.com"],
  ])("extracts %s", (input, expected) => {
    expect(normaliseSender(input)).toBe(expected);
  });

  it.each(["", "   ", "not-an-address", "a@b@c", "@nolocal", "nodomain@", null, undefined])(
    "rejects %s",
    (input) => {
      expect(normaliseSender(input as string)).toBeNull();
    },
  );
});

describe("parseAllowlist", () => {
  it("accepts newline, comma and semicolon separators", () => {
    const rules = parseAllowlist("payouts@stripe.com\n@paystack.com; dhl.com");
    expect(rules).toEqual([
      { kind: "address", value: "payouts@stripe.com" },
      { kind: "domain", value: "paystack.com" },
      { kind: "domain", value: "dhl.com" },
    ]);
  });

  it("treats a bare domain and an @-prefixed domain identically", () => {
    expect(parseAllowlist("stripe.com")).toEqual(parseAllowlist("@stripe.com"));
  });

  it("returns nothing for empty input", () => {
    for (const v of ["", "   ", "\n\n", null, undefined]) {
      expect(parseAllowlist(v as string)).toEqual([]);
    }
  });
});

describe("isSenderAllowed — fails closed", () => {
  // The single most important test here. "No list yet" must never mean
  // "accept anything" — that turns a half-configured source into an open inbox.
  it.each(["", "   ", null, undefined])("rejects everything when the list is %s", (list) => {
    expect(isSenderAllowed("payouts@stripe.com", list as string)).toBe(false);
  });

  it("rejects an unparseable sender even with a permissive list", () => {
    expect(isSenderAllowed("not-an-address", "@stripe.com")).toBe(false);
    expect(isSenderAllowed(null, "@stripe.com")).toBe(false);
  });
});

describe("isSenderAllowed — matching", () => {
  const list = "payouts@stripe.com\n@paystack.com";

  it("accepts an exact address match", () => {
    expect(isSenderAllowed("payouts@stripe.com", list)).toBe(true);
    expect(isSenderAllowed("Stripe <PAYOUTS@stripe.com>", list)).toBe(true);
  });

  it("accepts any address at an allowed domain", () => {
    expect(isSenderAllowed("settlements@paystack.com", list)).toBe(true);
    expect(isSenderAllowed("noreply@paystack.com", list)).toBe(true);
  });

  it("rejects a different address at a non-allowed domain", () => {
    expect(isSenderAllowed("billing@stripe.com", list)).toBe(false); // domain not listed, only that one address
    expect(isSenderAllowed("payouts@example.com", list)).toBe(false);
  });

  // The classic bypass: a suffix test would accept this.
  it("rejects a lookalike domain that merely ENDS WITH an allowed one", () => {
    expect(isSenderAllowed("payouts@evil-paystack.com", list)).toBe(false);
    expect(isSenderAllowed("payouts@notpaystack.com", list)).toBe(false);
  });

  // Subdomains are a different domain. Allow them explicitly if wanted.
  it("does not accept a subdomain of an allowed domain by default", () => {
    expect(isSenderAllowed("payouts@mail.paystack.com", list)).toBe(false);
  });

  it("uses the LAST @ when splitting, so a quoted local part cannot spoof the domain", () => {
    // If the domain were taken from the FIRST @, this would read as paystack.com.
    expect(isSenderAllowed("attacker@paystack.com@evil.com", list)).toBe(false);
  });
});

describe("isIngestibleAttachment", () => {
  it.each(["payouts.csv", "Report.XLSX", "remittance.xls", "data.tsv", "export.txt", "a.xlsm"])(
    "accepts %s",
    (n) => expect(isIngestibleAttachment(n)).toBe(true),
  );

  it.each([
    "invoice.pdf", "logo.png", "payload.exe", "script.sh", "archive.zip",
    "macro.docm", "noextension", "", null, undefined,
  ])("refuses %s", (n) => expect(isIngestibleAttachment(n as string)).toBe(false));

  it("refuses path separators and traversal in the filename", () => {
    expect(isIngestibleAttachment("../../etc/passwd.csv")).toBe(false);
    expect(isIngestibleAttachment("sub/dir/payouts.csv")).toBe(false);
    expect(isIngestibleAttachment("sub\\dir\\payouts.csv")).toBe(false);
  });

  it("refuses an absurdly long filename", () => {
    expect(isIngestibleAttachment(`${"a".repeat(600)}.csv`)).toBe(false);
  });

  // Double extensions are fine — only the FINAL one decides, and it must be
  // in the allow-list. "report.exe.csv" is parsed as a CSV, never executed.
  it("judges only the final extension", () => {
    expect(isIngestibleAttachment("report.exe.csv")).toBe(true);
    expect(isIngestibleAttachment("report.csv.exe")).toBe(false);
  });
});
