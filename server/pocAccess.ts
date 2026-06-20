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
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { pocAccessTokens } from "../drizzle/poc_schema";

export const POC_ACCESS_HEADER = "x-poc-access-token";

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

/** Non-throwing check used by the frontend gate. */
export async function checkPocAccess(pocKey: string, token: string | null | undefined): Promise<boolean> {
  if (!pocKey) return false;
  const row = await getAccess(pocKey);
  if (!row) return false; // not configured → no access
  if (!row.enabled) return true; // protection turned off for this POC
  return !!token && token === row.token;
}

/** Throwing guard used by gated POC procedures. */
export async function assertPocAccess(pocKey: string, token: string | null | undefined): Promise<void> {
  if (!pocKey) throw new TRPCError({ code: "BAD_REQUEST", message: "Missing POC key" });
  const row = await getAccess(pocKey);
  if (!row) {
    throw new TRPCError({ code: "FORBIDDEN", message: "This POC is not yet available. Please request an access link." });
  }
  if (!row.enabled) return; // protection disabled
  if (!token || token !== row.token) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Invalid or missing access code for this POC." });
  }
}
