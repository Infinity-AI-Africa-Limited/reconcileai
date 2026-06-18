import { describe, it, expect } from "vitest";
import {
  signReport,
  verifyReport,
  contentHashOf,
  canonicalize,
  publicKeyFingerprint,
  publicKeyPem,
} from "./signing";

describe("report signing (Ed25519)", () => {
  it("canonicalizes payloads independent of key order", () => {
    const a = canonicalize({ b: 1, a: { y: 2, x: 1 } });
    const b = canonicalize({ a: { x: 1, y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(contentHashOf({ b: 1, a: 2 })).toBe(contentHashOf({ a: 2, b: 1 }));
  });

  it("signs and verifies a report", () => {
    const payload = { id: 1, reportData: { aml: { value: "ok" } }, score: 92 };
    const sig = signReport(payload);
    expect(sig.signature.length).toBeGreaterThan(0);
    expect(sig.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const result = verifyReport({
      payload,
      contentHash: sig.contentHash,
      signature: sig.signature,
      signingKeyFingerprint: sig.signingKeyFingerprint,
    });
    expect(result.valid).toBe(true);
    expect(result.hashMatches).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.fingerprintMatches).toBe(true);
  });

  it("detects tampering — any content change breaks the seal", () => {
    const payload = { id: 1, reportData: { aml: { value: "ok" } }, score: 92 };
    const sig = signReport(payload);

    const tampered = { ...payload, score: 100 }; // changed after signing
    const result = verifyReport({
      payload: tampered,
      contentHash: sig.contentHash,
      signature: sig.signature,
      signingKeyFingerprint: sig.signingKeyFingerprint,
    });
    expect(result.hashMatches).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("rejects a forged signature", () => {
    const payload = { id: 7 };
    const sig = signReport(payload);
    const forged = Buffer.from("not-a-real-signature").toString("base64");
    const result = verifyReport({
      payload,
      contentHash: sig.contentHash,
      signature: forged,
    });
    expect(result.signatureValid).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("exposes a stable public key + fingerprint within the process", () => {
    const fp1 = publicKeyFingerprint();
    const fp2 = publicKeyFingerprint();
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{32}$/);
    expect(publicKeyPem()).toContain("BEGIN PUBLIC KEY");
  });
});
