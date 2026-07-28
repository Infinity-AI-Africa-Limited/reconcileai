/**
 * Lightweight per-POC access control.
 *
 * Public POC pages (Woodcore, LAPO, Salad, and any future POC) are invite-only:
 * the link carries a secret token (`?key=…`), the browser sends it as the
 * `x-poc-access-token` header, and the POC tRPC procedures validate it here.
 * This is enforced server-side (a frontend gate alone is bypassable).
 *
 * Secure-by-default: a POC key with no token row denies public access until a
 * super-admin generates one (the POC Hub does this on view). Future POCs are
 * therefore protected automatically.
 */
import crypto from "node:crypto";
import { eq, like } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { pocAccessTokens } from "../drizzle/poc_schema";

export const POC_ACCESS_HEADER = "x-poc-access-token";

/**
 * Per-recipient invites.
 *
 * A document shared with several parties needs a link per party — so a leak is
 * attributable and one recipient can be cut off without disturbing the rest.
 * These live in the same table under a namespaced key, `<pocKey>:<recipient>`
 * (e.g. "deployment_runbook:acme-bank"), which keeps them revocable and needs no
 * schema change. The suffix is the recipient label the viewer is watermarked
 * with. Revoking deletes the row outright, so `enabled` keeps its original
 * meaning on the base row only (false = protection off for that POC).
 */
const RECIPIENT_SLUG = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** Escape LIKE wildcards so a pocKey containing `_` cannot over-match. */
function likePrefix(base: string): string {
  return base.replace(/[%_\\]/g, "\\$&") + ":%";
}

export function recipientKey(pocKey: string, recipient: string): string {
  if (!RECIPIENT_SLUG.test(recipient)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Recipient must be 1–39 characters: lowercase letters, numbers and hyphens.",
    });
  }
  return `${pocKey}:${recipient}`;
}

function newToken(): string {
  return crypto.randomBytes(18).toString("base64url"); // ~24 chars, URL-safe
}

/** Read the access token a request presented (header, case-insensitive). */
export function tokenFromCtx(ctx: any): string | null {
  const h = ctx?.req?.headers?.[POC_ACCESS_HEADER];
  if (!h) return null;
  return Array.isArray(h) ? (h[0] ?? null) : String(h);
}

export async function getAccess(pocKey: string) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select().from(pocAccessTokens).where(eq(pocAccessTokens.pocKey, pocKey)).limit(1);
  return row ?? null;
}

/** Fetch the token row, creating one (random token, enabled) if missing. Admin use. */
export async function getOrCreateAccess(pocKey: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const existing = await getAccess(pocKey);
  if (existing) return existing;
  await db.insert(pocAccessTokens).values({ pocKey, token: newToken(), enabled: true });
  return (await getAccess(pocKey))!;
}

export async function regenerateAccess(pocKey: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  await getOrCreateAccess(pocKey);
  const token = newToken();
  await db.update(pocAccessTokens).set({ token }).where(eq(pocAccessTokens.pocKey, pocKey));
  return getAccess(pocKey);
}

export async function setAccessEnabled(pocKey: string, enabled: boolean) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  await getOrCreateAccess(pocKey);
  await db.update(pocAccessTokens).set({ enabled }).where(eq(pocAccessTokens.pocKey, pocKey));
  return getAccess(pocKey);
}

/** List the per-recipient invites issued for a document. */
export async function listRecipientInvites(pocKey: string) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(pocAccessTokens)
    .where(like(pocAccessTokens.pocKey, likePrefix(pocKey)));
  const prefix = `${pocKey}:`;
  return rows
    .filter((r) => r.pocKey.startsWith(prefix))
    .map((r) => ({
      recipient: r.pocKey.slice(prefix.length),
      token: r.token,
      createdAt: r.createdAt,
    }));
}

export async function createRecipientInvite(pocKey: string, recipient: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const key = recipientKey(pocKey, recipient);
  if (await getAccess(key)) {
    throw new TRPCError({ code: "CONFLICT", message: `An invite for "${recipient}" already exists.` });
  }
  // The base row must exist, otherwise the document itself is unconfigured.
  await getOrCreateAccess(pocKey);
  const token = newToken();
  await db.insert(pocAccessTokens).values({ pocKey: key, token, enabled: true });
  return { recipient, token };
}

/** Revoking deletes the row, so the link dies immediately and unambiguously. */
export async function revokeRecipientInvite(pocKey: string, recipient: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  await db.delete(pocAccessTokens).where(eq(pocAccessTokens.pocKey, recipientKey(pocKey, recipient)));
  return { recipient };
}

/**
 * Resolve a presented token against a POC and any per-recipient invites.
 * Returns the recipient label when the token is a per-recipient invite, so the
 * caller can watermark the view with it.
 */
export async function resolveAccess(
  pocKey: string,
  token: string | null | undefined,
): Promise<{ valid: boolean; recipient: string | null }> {
  const deny = { valid: false, recipient: null };
  if (!pocKey) return deny;
  const base = await getAccess(pocKey);
  if (!base) return deny; // not configured → no access
  if (!base.enabled) return { valid: true, recipient: null }; // protection turned off
  if (!token) return deny;
  if (token === base.token) return { valid: true, recipient: null };

  const invites = await listRecipientInvites(pocKey);
  const hit = invites.find((i) => i.token === token);
  return hit ? { valid: true, recipient: hit.recipient } : deny;
}

/** Non-throwing check used by the frontend gate. */
export async function checkPocAccess(pocKey: string, token: string | null | undefined): Promise<boolean> {
  return (await resolveAccess(pocKey, token)).valid;
}

/** Throwing guard used by gated POC procedures. */
export async function assertPocAccess(pocKey: string, token: string | null | undefined): Promise<void> {
  if (!pocKey) throw new TRPCError({ code: "BAD_REQUEST", message: "Missing POC key" });
  const base = await getAccess(pocKey);
  if (!base) {
    throw new TRPCError({ code: "FORBIDDEN", message: "This POC is not yet available. Please request an access link." });
  }
  const { valid } = await resolveAccess(pocKey, token);
  if (!valid) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Invalid or missing access code for this POC." });
  }
}
