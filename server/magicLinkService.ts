/**
 * Magic Link Service
 * Generates one-time login tokens and emails sign-in links to users.
 * Tokens expire after 72 hours and are single-use.
 */
import crypto from "crypto";
import { getDb } from "./db";
import { magicLinkTokens, users } from "../drizzle/schema";
import { eq, and, gt, isNull } from "drizzle-orm";
import { sendEmail, renderBrandedHtml, renderButton, escapeHtml } from "./_core/email";

const TOKEN_TTL_HOURS = 72;

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Administrator",
  admin: "Administrator",
  cfo: "CFO / Finance",
  operations: "Operations",
  compliance: "Compliance / Audit",
  user: "Standard User",
};

const ROLE_ACCESS: Record<string, string> = {
  super_admin: "Cross-tenant platform administration and full system access.",
  admin: "Full system access including user management, reconciliation, reports, and settings.",
  cfo: "Read-only access to CFO dashboard, channel performance metrics, and financial reports.",
  operations: "Access to reconciliation jobs, exception management, data upload, and schedules.",
  compliance: "Read-only access to audit trail, CBN compliance reports, and exception history.",
  user: "Standard access to reconciliation and reports.",
};

// ─── Generate & Store Token ──────────────────────────────────────────
export async function createMagicLinkToken(userId: number): Promise<string> {
  const drizzle = await getDb();
  if (!drizzle) throw new Error("DB unavailable");

  const token = crypto.randomBytes(48).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);

  await drizzle.insert(magicLinkTokens).values({ userId, token, expiresAt });
  return token;
}

// ─── Consume Token (returns userId if valid) ─────────────────────────
export async function consumeMagicLinkToken(token: string): Promise<number | null> {
  const drizzle = await getDb();
  if (!drizzle) return null;

  const now = new Date();
  const rows = await drizzle
    .select()
    .from(magicLinkTokens)
    .where(
      and(
        eq(magicLinkTokens.token, token),
        gt(magicLinkTokens.expiresAt, now),
        isNull(magicLinkTokens.usedAt)
      )
    )
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  // Mark as used
  await drizzle
    .update(magicLinkTokens)
    .set({ usedAt: now })
    .where(eq(magicLinkTokens.id, row.id));

  return row.userId;
}

// ─── Send Welcome Email (admin-created user) ─────────────────────────
export async function sendWelcomeEmail(params: {
  userId: number;
  name: string;
  email: string;
  role: string;
  origin: string;
}): Promise<{ success: boolean; magicLink: string }> {
  const { userId, name, email, role, origin } = params;

  const token = await createMagicLinkToken(userId);
  const magicLink = `${origin}/magic-login?token=${token}`;
  const safeName = escapeHtml(name);

  const subject = "Welcome to ReconcileAI — your account is ready";
  const body = `
    <p style="font-size:18px;font-weight:700;color:#1B365D;margin:0 0 12px;">Welcome to ReconcileAI, ${safeName}!</p>
    <p>Your account has been created by an administrator. Use the button below to sign in.</p>
    ${renderButton("Sign in to ReconcileAI", magicLink)}
    <p style="font-size:13px;color:#64748b;margin:16px 0 4px;font-weight:600;">Your account details</p>
    <ul style="margin:4px 0 16px;padding-left:20px;font-size:14px;">
      <li><strong>Name:</strong> ${safeName}</li>
      <li><strong>Email:</strong> ${escapeHtml(email)}</li>
      <li><strong>Role:</strong> ${escapeHtml(ROLE_LABELS[role] ?? role)}</li>
      <li><strong>Access:</strong> ${escapeHtml(ROLE_ACCESS[role] ?? "Standard access")}</li>
    </ul>
    <p style="font-size:13px;color:#64748b;">If the button doesn't work, paste this link into your browser:<br />
      <span style="word-break:break-all;color:#1B365D;">${magicLink}</span></p>
    <p style="font-size:12px;color:#94a3b8;margin-top:16px;">This link is single-use and expires in ${TOKEN_TTL_HOURS} hours. If you did not expect this invitation, please contact your administrator.</p>
  `;
  const text = `Welcome to ReconcileAI, ${name}. Sign in (valid ${TOKEN_TTL_HOURS}h, single-use): ${magicLink}`;

  const result = await sendEmail({ to: email, subject, html: renderBrandedHtml(subject, body), text });
  return { success: result.success, magicLink };
}

// ─── Send Login Link (self-service, by email) ────────────────────────
// Looks up an active, non-guest user by email and emails them a sign-in link.
// Resolves quietly regardless of whether the account exists (no enumeration).
export async function sendLoginLinkEmail(params: {
  email: string;
  origin: string;
}): Promise<{ sent: boolean }> {
  const { email, origin } = params;
  const drizzle = await getDb();
  if (!drizzle) return { sent: false };

  const rows = await drizzle.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  if (!user || !user.isActive || user.isGuest) {
    return { sent: false };
  }

  const token = await createMagicLinkToken(user.id);
  const magicLink = `${origin}/magic-login?token=${token}`;

  const subject = "Your ReconcileAI sign-in link";
  const body = `
    <p style="font-size:18px;font-weight:700;color:#1B365D;margin:0 0 12px;">Sign in to ReconcileAI</p>
    <p>Click the button below to sign in. This link is valid for ${TOKEN_TTL_HOURS} hours and can be used once.</p>
    ${renderButton("Sign in to ReconcileAI", magicLink)}
    <p style="font-size:13px;color:#64748b;">If the button doesn't work, paste this link into your browser:<br />
      <span style="word-break:break-all;color:#1B365D;">${magicLink}</span></p>
    <p style="font-size:12px;color:#94a3b8;margin-top:16px;">If you didn't request this email, you can safely ignore it — no one can sign in without this link.</p>
  `;
  const text = `Sign in to ReconcileAI (valid ${TOKEN_TTL_HOURS}h, single-use): ${magicLink}`;

  const result = await sendEmail({ to: email, subject, html: renderBrandedHtml(subject, body), text });
  return { sent: result.success };
}
