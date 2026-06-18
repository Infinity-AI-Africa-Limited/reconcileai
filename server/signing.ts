/**
 * Cryptographic report signing (Ed25519).
 *
 * CBN examination reports are presented as "timestamped, digitally signed."
 * This module makes that literally true: it canonicalises the report payload,
 * hashes it (SHA-256), and signs the hash with an Ed25519 private key. The
 * signature + content hash + public-key fingerprint are persisted alongside the
 * submission, and `verifyReport()` recomputes everything to prove a report has
 * not been altered since signing (tamper-evidence).
 *
 * Key management:
 *   CBN_SIGNING_PRIVATE_KEY  — PEM (PKCS#8) Ed25519 private key. RECOMMENDED in
 *                              production so signatures survive restarts/redeploys
 *                              and can be verified by third parties against the
 *                              published public key.
 *   If unset, an ephemeral keypair is generated once per process (dev/demo). A
 *   loud warning is logged because such signatures don't persist across restarts.
 */
import crypto from "node:crypto";
import { ENV } from "./_core/env";

let cachedPrivateKey: crypto.KeyObject | null = null;
let cachedPublicKey: crypto.KeyObject | null = null;
let warnedEphemeral = false;

function loadKeys(): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } {
  if (cachedPrivateKey && cachedPublicKey) {
    return { privateKey: cachedPrivateKey, publicKey: cachedPublicKey };
  }

  const pem = ENV.cbnSigningPrivateKey.trim();
  if (pem) {
    const privateKey = crypto.createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("CBN_SIGNING_PRIVATE_KEY must be an Ed25519 PKCS#8 PEM key");
    }
    const publicKey = crypto.createPublicKey(privateKey);
    cachedPrivateKey = privateKey;
    cachedPublicKey = publicKey;
    return { privateKey, publicKey };
  }

  // Dev/demo fallback: ephemeral keypair (does not persist across restarts).
  if (!warnedEphemeral) {
    console.warn(
      "[signing] CBN_SIGNING_PRIVATE_KEY not set — using an EPHEMERAL Ed25519 key. " +
        "Signatures will not verify after a restart/redeploy. Set CBN_SIGNING_PRIVATE_KEY in production.",
    );
    warnedEphemeral = true;
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  cachedPrivateKey = privateKey;
  cachedPublicKey = publicKey;
  return { privateKey, publicKey };
}

/**
 * Deterministic JSON serialization: object keys sorted recursively so the same
 * logical payload always hashes identically regardless of property order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex of the canonical form of a payload. */
export function contentHashOf(payload: unknown): string {
  return crypto.createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");
}

/** SHA-256 (first 32 hex chars) fingerprint of the active public key (SPKI DER). */
export function publicKeyFingerprint(): string {
  const { publicKey } = loadKeys();
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
}

/** The active public key as PEM, for publication / third-party verification. */
export function publicKeyPem(): string {
  const { publicKey } = loadKeys();
  return (publicKey.export({ type: "spki", format: "pem" }) as string).trim();
}

export type SignedReport = {
  contentHash: string;
  signature: string; // base64
  signingKeyFingerprint: string;
  signedAt: Date;
};

/** Sign a report payload. The signature is over the content hash. */
export function signReport(payload: unknown): SignedReport {
  const { privateKey } = loadKeys();
  const contentHash = contentHashOf(payload);
  // Ed25519 signs the message directly (no separate digest algorithm).
  const signature = crypto.sign(null, Buffer.from(contentHash, "utf8"), privateKey);
  return {
    contentHash,
    signature: signature.toString("base64"),
    signingKeyFingerprint: publicKeyFingerprint(),
    signedAt: new Date(),
  };
}

/**
 * Verify a signature against a payload. Returns a structured result:
 * - hashMatches: the payload still hashes to the signed contentHash (no tampering)
 * - signatureValid: the signature verifies against the (expected) public key
 * Both must be true for a report to be considered authentic and unaltered.
 */
export function verifyReport(params: {
  payload: unknown;
  contentHash: string;
  signature: string; // base64
  signingKeyFingerprint?: string | null;
}): { valid: boolean; hashMatches: boolean; signatureValid: boolean; fingerprintMatches: boolean } {
  const { publicKey } = loadKeys();
  const recomputed = contentHashOf(params.payload);
  const hashMatches = recomputed === params.contentHash;

  let signatureValid = false;
  try {
    signatureValid = crypto.verify(
      null,
      Buffer.from(params.contentHash, "utf8"),
      publicKey,
      Buffer.from(params.signature, "base64"),
    );
  } catch {
    signatureValid = false;
  }

  const fingerprintMatches = params.signingKeyFingerprint
    ? params.signingKeyFingerprint === publicKeyFingerprint()
    : true;

  return {
    valid: hashMatches && signatureValid && fingerprintMatches,
    hashMatches,
    signatureValid,
    fingerprintMatches,
  };
}
