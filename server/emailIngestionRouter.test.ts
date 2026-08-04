/**
 * Email-forward ingestion — configuration surface.
 *
 * The tests that matter here are the ones pinning agreement between the module
 * that ISSUES a configuration and the module that ENFORCES it. Each half is
 * already covered alone; the expensive failure is the pair drifting, because
 * both keep passing while every real delivery is refused:
 *
 *   - a token the address parser will not match  => a dead address
 *   - an allow-list entry the sender check will never match => an inbox that
 *     accepts nothing while reporting itself configured
 *
 * Both are silent by construction, which is why they are asserted across the
 * module boundary rather than within it.
 */
import { describe, it, expect } from "vitest";

// The router pulls in db + env; neither is touched by the pure helpers, but the
// handler side imports getDb at module scope.
import { vi } from "vitest";
vi.mock("../server/db", () => ({ getDb: vi.fn().mockResolvedValue(null), channelScope: vi.fn() }));

import { generateAddressToken, forwardingAddress, inboundReadiness } from "./routers/emailIngestion";
import { validateAllowlist, isSenderAllowed } from "./ingest/senderAllowlist";
import { extractAddressToken } from "./ingest/emailIngestionService";

describe("generateAddressToken", () => {
  it("produces a lowercase hex token of the length the address parser expects", () => {
    const token = generateAddressToken();
    // The handler matches settle-([a-z0-9]{8,64})@ — an uppercase or symbol
    // character here would make every issued address unroutable.
    expect(token).toMatch(/^[a-z0-9]{8,64}$/);
    expect(token).toHaveLength(32);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateAddressToken()));
    expect(tokens.size).toBe(200);
  });

  it("round-trips through the inbound address parser", () => {
    // The contract that makes an issued address actually work. If either side
    // changes its shape, this fails instead of production going quiet.
    const token = generateAddressToken();
    const address = forwardingAddress(token, "inbound.reconcileaiafrica.com");
    expect(address).not.toBeNull();
    expect(extractAddressToken([address!])).toBe(token);
  });
});

describe("forwardingAddress", () => {
  it("formats the address the merchant forwards to", () => {
    expect(forwardingAddress("abc123", "inbound.example.com")).toBe("settle-abc123@inbound.example.com");
  });

  it("returns null rather than a half-formed address when no domain is configured", () => {
    // A string like "settle-abc123@" would be copied into a mail rule and drop
    // every message. Null forces the UI to explain instead.
    expect(forwardingAddress("abc123", "")).toBeNull();
  });
});

describe("inboundReadiness", () => {
  // The failure this exists to prevent is documented in CLAUDE.md §19.4: on
  // production BOTH env vars are set while the domain was never registered for
  // receiving, so a banner keyed on configuration reads green on a channel that
  // has never carried a single message.
  it("does NOT report success on configuration alone", () => {
    expect(inboundReadiness(true, true, false)).toBe("unproven");
  });

  it("reports success only once a delivery has actually landed", () => {
    expect(inboundReadiness(true, true, true)).toBe("receiving");
  });

  it("reports unconfigured when either half of the setup is missing", () => {
    expect(inboundReadiness(false, true, false)).toBe("unconfigured");
    expect(inboundReadiness(true, false, false)).toBe("unconfigured");
    expect(inboundReadiness(false, false, false)).toBe("unconfigured");
  });

  it("still reports unconfigured if evidence exists but config has since been removed", () => {
    // Rotating a secret out must not leave a stale green banner behind.
    expect(inboundReadiness(true, false, true)).toBe("unconfigured");
  });
});

describe("validateAllowlist", () => {
  it("rejects an empty list — the enforcer fails closed, so this must too", () => {
    for (const raw of [null, undefined, "", "   ", "\n,;"]) {
      const r = validateAllowlist(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.invalid).toEqual([]);
    }
  });

  it("accepts full addresses, @domains and bare domains", () => {
    expect(validateAllowlist("payouts@stripe.com").ok).toBe(true);
    expect(validateAllowlist("@dhl.com").ok).toBe(true);
    expect(validateAllowlist("dhl.com").ok).toBe(true);
    expect(validateAllowlist("payouts@stripe.com\n@dhl.com\nflutterwave.com").ok).toBe(true);
  });

  it("names the entries that are wrong, so the message can point at them", () => {
    const r = validateAllowlist("payouts@stripe.com\nnot an email\n@nope");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.invalid).toContain("@not an email");
      expect(r.invalid).toContain("@nope");
      expect(r.invalid).not.toContain("payouts@stripe.com");
    }
  });

  it("rejects a dotless domain, which could never match a real sender", () => {
    expect(validateAllowlist("@localhost").ok).toBe(false);
  });

  it("rejects an address with more than one @, which normaliseSender would drop", () => {
    expect(validateAllowlist("a@b@c.com").ok).toBe(false);
  });
});

describe("configuration and enforcement agree", () => {
  // Anything accepted at save time must actually let mail through, and anything
  // let through must have been acceptable. Either direction failing produces a
  // source that looks right and behaves otherwise.
  const cases: Array<{ list: string; sender: string; allowed: boolean; why: string }> = [
    { list: "payouts@stripe.com", sender: "payouts@stripe.com", allowed: true, why: "exact address" },
    { list: "payouts@stripe.com", sender: "Stripe <payouts@stripe.com>", allowed: true, why: "display-name wrapped" },
    { list: "payouts@stripe.com", sender: "PAYOUTS@STRIPE.COM", allowed: true, why: "case-insensitive" },
    { list: "@dhl.com", sender: "remittance@dhl.com", allowed: true, why: "domain rule" },
    { list: "dhl.com", sender: "remittance@dhl.com", allowed: true, why: "bare domain rule" },
    { list: "@stripe.com", sender: "payouts@evil-stripe.com", allowed: false, why: "lookalike domain" },
    { list: "@stripe.com", sender: "payouts@stripe.com.evil.net", allowed: false, why: "domain as a prefix" },
    { list: "payouts@stripe.com", sender: "other@stripe.com", allowed: false, why: "address rule is not a domain rule" },
  ];

  for (const c of cases) {
    it(`${c.allowed ? "accepts" : "refuses"} ${c.why}`, () => {
      expect(validateAllowlist(c.list).ok).toBe(true);
      expect(isSenderAllowed(c.sender, c.list)).toBe(c.allowed);
    });
  }
});
