/**
 * Magic Link Service
 * Generates one-time login tokens and sends welcome emails to newly added users.
 * Tokens expire after 72 hours and are single-use.
 */
import crypto from "crypto";
import { getDb } from "./db";
import { magicLinkTokens, users } from "../drizzle/schema";
import { eq, and, gt, isNull } from "drizzle-orm";
import { notifyOwner } from "./_core/notification";

const TOKEN_TTL_HOURS = 72;

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

// ─── Send Welcome Email ──────────────────────────────────────────────
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

  const roleLabels: Record<string, string> = {
    admin: "Administrator",
    cfo: "CFO / Finance",
    operations: "Operations",
    compliance: "Compliance / Audit",
    user: "Standard User",
  };

  const roleAccess: Record<string, string> = {
    admin: "Full system access including user management, reconciliation, reports, and settings.",
    cfo: "Read-only access to CFO dashboard, channel performance metrics, and financial reports.",
    operations: "Access to reconciliation jobs, exception management, data upload, and schedules.",
    compliance: "Read-only access to audit trail, CBN compliance reports, and exception history.",
    user: "Standard access to reconciliation and reports.",
  };

  const title = `Welcome to ReconcileAI — Your Account is Ready`;
  const content = `
# Welcome to ReconcileAI, ${name}!

Your account has been created by an administrator. You can now log in to the portal using the link below.

**Your Account Details:**
- **Name:** ${name}
- **Email:** ${email}
- **Role:** ${roleLabels[role] ?? role}
- **Access Level:** ${roleAccess[role] ?? "Standard access"}

## One-Click Login

Click the link below to log in immediately (valid for ${TOKEN_TTL_HOURS} hours):

[Log in to ReconcileAI →](${magicLink})

If the button above doesn't work, copy and paste this URL into your browser:
\`${magicLink}\`

> **Security note:** This link is single-use and expires in ${TOKEN_TTL_HOURS} hours. If you did not expect this invitation, please contact your administrator.

---
*This message was sent by ReconcileAI on behalf of your organisation's administrator.*
`.trim();

  const sent = await notifyOwner({ title, content });
  return { success: sent, magicLink };
}
