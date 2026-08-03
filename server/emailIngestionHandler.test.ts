/**
 * Inbound email handler — gate ordering and address parsing.
 *
 * The ORDER of the checks is itself a security property. Signature must be
 * proven before anything else runs, and an unknown address must be refused
 * before a sender is even considered — otherwise the endpoint leaks which
 * addresses exist through timing or behaviour differences.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

// ENV is a frozen snapshot taken when _core/env is first imported, so the
// secret must exist BEFORE any import evaluates. vi.hoisted runs early enough;
// setting process.env in beforeEach does not, and every signed case would then
// fail as `missing_secret` — passing tests for entirely the wrong reason.
const SECRET_RAW = vi.hoisted(() => {
  const raw = Buffer.from("inbound-test-signing-key-value").toString("base64");
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${raw}`;
  return raw;
});

// No DB in unit tests: the handler must fail safe, not throw, without one.
vi.mock("../server/db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));

import { handleInboundEmail, extractAddressToken } from "./ingest/emailIngestionService";

const ID = "msg_inbound_1";

function signed(body: string, secret = SECRET_RAW, tsSeconds = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(secret, "base64");
  const sig = createHmac("sha256", key).update(`${ID}.${tsSeconds}.${body}`).digest("base64");
  return { id: ID, timestamp: String(tsSeconds), signature: `v1,${sig}` };
}

const BODY = JSON.stringify({
  type: "email.received",
  data: {
    email_id: "e_1",
    from: "payouts@stripe.com",
    to: ["settle-abc123def456@inbound.reconcileaiafrica.com"],
    subject: "Daily payout",
    attachments: [{ id: "att_1", filename: "payouts.csv" }],
  },
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("extractAddressToken", () => {
  it("reads the token from a settle- address", () => {
    expect(extractAddressToken(["settle-abc123def456@inbound.example.com"])).toBe("abc123def456");
  });

  it("handles a display-name wrapped recipient", () => {
    expect(extractAddressToken(['ReconcileAI <settle-Abc123Def456@inbound.example.com>'])).toBe("abc123def456");
  });

  it("finds the token among several recipients", () => {
    expect(extractAddressToken(["ops@merchant.com", "settle-tok123456@inbound.example.com"])).toBe("tok123456");
  });

  it.each([
    ["a non-settle address", ["hello@inbound.example.com"]],
    ["a token that is too short", ["settle-abc@inbound.example.com"]],
    ["an unparseable recipient", ["not-an-address"]],
    ["no recipients at all", []],
  ])("returns null for %s", (_label, recipients) => {
    expect(extractAddressToken(recipients as string[])).toBeNull();
  });

  // The token is the routing key, so it must not be spoofable by prefixing.
  it("does not match when settle- is not at the start of the local part", () => {
    expect(extractAddressToken(["evilsettle-abc123def456@inbound.example.com"])).toBeNull();
  });
});

describe("handleInboundEmail — signature is checked first", () => {
  it("rejects an unsigned delivery with 401", async () => {
    const r = await handleInboundEmail(BODY, {});
    expect(r.status).toBe(401);
  });

  it("rejects a tampered body with 401", async () => {
    const headers = signed(BODY);
    const tampered = BODY.replace("payouts@stripe.com", "attacker@evil.com");
    const r = await handleInboundEmail(tampered, headers);
    expect(r.status).toBe(401);
  });

  it("rejects a replayed (stale) delivery with 401", async () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const r = await handleInboundEmail(BODY, signed(BODY, SECRET_RAW, old));
    expect(r.status).toBe(401);
  });

  // The unset-secret case (fail closed, never "skip verification") is exercised
  // directly in svixSignature.test.ts. It cannot be reached from here: ENV is a
  // frozen snapshot taken at import, so clearing process.env mid-test has no
  // effect and the assertion would pass or fail for unrelated reasons.

  it("rejects a signature valid for a different message id", async () => {
    const key = Buffer.from(SECRET_RAW, "base64");
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", key).update(`other_msg.${ts}.${BODY}`).digest("base64");
    const r = await handleInboundEmail(BODY, { id: ID, timestamp: String(ts), signature: `v1,${sig}` });
    expect(r.status).toBe(401);
  });
});

describe("handleInboundEmail — business rejections answer 200", () => {
  // Resend retries non-2xx for hours. A rejection that will never succeed on
  // retry must be acknowledged, not retried.
  it("acknowledges a signed delivery it cannot process", async () => {
    const r = await handleInboundEmail(BODY, signed(BODY));
    expect(r.status).toBe(200);
  });

  it("ignores event types other than email.received", async () => {
    const other = JSON.stringify({ type: "email.delivered", data: {} });
    const r = await handleInboundEmail(other, signed(other));
    expect(r).toMatchObject({ status: 200, reason: "ignored_event_type" });
  });

  it("acknowledges an unparseable payload rather than throwing", async () => {
    const junk = "this is not json";
    const r = await handleInboundEmail(junk, signed(junk));
    expect(r).toMatchObject({ status: 200, reason: "unparseable_payload" });
  });

  it("does not throw when the database is unavailable", async () => {
    const r = await handleInboundEmail(BODY, signed(BODY));
    expect(r.status).toBe(200);
    if (r.status === 200) expect(r.reason).toBe("database_unavailable");
  });
});
