/**
 * Svix signature verification — the gate on the only inbound surface where an
 * unauthenticated stranger hands us a file.
 *
 * The negative cases matter more than the positive one. A verifier that accepts
 * a tampered body, a replayed request, or an empty secret is worse than none at
 * all, because it looks like security. CLAUDE.md §2B.9b records the SHOPLINE
 * OAuth path shipping exactly those mistakes.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { verifySvixSignature, SVIX_TOLERANCE_SECONDS } from "./ingest/svixSignature";

const SECRET_RAW = Buffer.from("a-test-signing-key-of-some-length").toString("base64");
const SECRET = `whsec_${SECRET_RAW}`;
const ID = "msg_2abcdef";
const BODY = JSON.stringify({ type: "email.received", data: { email_id: "e_1" } });

/** Produce a genuine signature the way Svix would. */
function sign(body: string, id: string, tsSeconds: number, secret = SECRET_RAW): string {
  const key = Buffer.from(secret, "base64");
  const sig = createHmac("sha256", key).update(`${id}.${tsSeconds}.${body}`).digest("base64");
  return `v1,${sig}`;
}

const NOW = 1_800_000_000_000; // fixed clock
const TS = Math.floor(NOW / 1000);

function headers(over: Partial<Record<"id" | "timestamp" | "signature", string>> = {}) {
  return {
    id: over.id ?? ID,
    timestamp: over.timestamp ?? String(TS),
    signature: over.signature ?? sign(BODY, ID, TS),
  };
}

describe("verifySvixSignature — accepts genuine deliveries", () => {
  it("accepts a correctly signed payload", () => {
    expect(verifySvixSignature(BODY, headers(), SECRET, NOW)).toEqual({ ok: true });
  });

  it("accepts a Buffer body identically to a string", () => {
    expect(verifySvixSignature(Buffer.from(BODY, "utf8"), headers(), SECRET, NOW)).toEqual({ ok: true });
  });

  it("accepts a secret supplied without the whsec_ prefix", () => {
    expect(verifySvixSignature(BODY, headers(), SECRET_RAW, NOW)).toEqual({ ok: true });
  });

  it("accepts when several signatures are present (secret rotation)", () => {
    const rotated = `v1,AAAAinvalidAAAA ${sign(BODY, ID, TS)}`;
    expect(verifySvixSignature(BODY, headers({ signature: rotated }), SECRET, NOW)).toEqual({ ok: true });
  });

  it("accepts at the edge of the tolerance window", () => {
    const edge = TS - SVIX_TOLERANCE_SECONDS + 1;
    const h = { id: ID, timestamp: String(edge), signature: sign(BODY, ID, edge) };
    expect(verifySvixSignature(BODY, h, SECRET, NOW)).toEqual({ ok: true });
  });
});

describe("verifySvixSignature — rejects everything else", () => {
  it("rejects a tampered body", () => {
    const tampered = BODY.replace("e_1", "e_2");
    expect(verifySvixSignature(tampered, headers(), SECRET, NOW))
      .toEqual({ ok: false, reason: "no_matching_signature" });
  });

  it("rejects a signature made with a different secret", () => {
    const other = Buffer.from("a-completely-different-key!!").toString("base64");
    const h = headers({ signature: sign(BODY, ID, TS, other) });
    expect(verifySvixSignature(BODY, h, SECRET, NOW))
      .toEqual({ ok: false, reason: "no_matching_signature" });
  });

  // Replay protection. A captured request must not stay valid forever.
  it("rejects a stale timestamp even when the signature is valid", () => {
    const old = TS - SVIX_TOLERANCE_SECONDS - 60;
    const h = { id: ID, timestamp: String(old), signature: sign(BODY, ID, old) };
    expect(verifySvixSignature(BODY, h, SECRET, NOW))
      .toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("rejects a far-future timestamp", () => {
    const future = TS + SVIX_TOLERANCE_SECONDS + 60;
    const h = { id: ID, timestamp: String(future), signature: sign(BODY, ID, future) };
    expect(verifySvixSignature(BODY, h, SECRET, NOW))
      .toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("rejects a signature that is valid for a DIFFERENT message id", () => {
    // The id is part of the signed content, so replaying one message's
    // signature onto another must fail.
    const h = headers({ signature: sign(BODY, "msg_someone_else", TS) });
    expect(verifySvixSignature(BODY, h, SECRET, NOW))
      .toEqual({ ok: false, reason: "no_matching_signature" });
  });

  it.each([
    ["id", { id: "" }],
    ["timestamp", { timestamp: "" }],
    ["signature", { signature: "" }],
  ])("rejects when the %s header is missing", (_label, over) => {
    expect(verifySvixSignature(BODY, headers(over as never), SECRET, NOW))
      .toEqual({ ok: false, reason: "missing_headers" });
  });

  // An unconfigured secret must FAIL CLOSED. Treating "no secret" as "no
  // checking required" would leave the endpoint wide open the moment an env var
  // is forgotten — which is precisely how the SHOPLINE install path broke.
  it("rejects when no secret is configured", () => {
    expect(verifySvixSignature(BODY, headers(), "", NOW))
      .toEqual({ ok: false, reason: "missing_secret" });
  });

  it("rejects a non-numeric timestamp", () => {
    expect(verifySvixSignature(BODY, headers({ timestamp: "not-a-number" }), SECRET, NOW))
      .toEqual({ ok: false, reason: "bad_timestamp" });
  });

  it("rejects an unknown signature version", () => {
    const sig = sign(BODY, ID, TS).replace("v1,", "v9,");
    expect(verifySvixSignature(BODY, headers({ signature: sig }), SECRET, NOW))
      .toEqual({ ok: false, reason: "no_matching_signature" });
  });

  it("rejects a bare signature with no version prefix", () => {
    const sig = sign(BODY, ID, TS).replace("v1,", "");
    expect(verifySvixSignature(BODY, headers({ signature: sig }), SECRET, NOW))
      .toEqual({ ok: false, reason: "no_matching_signature" });
  });
});
