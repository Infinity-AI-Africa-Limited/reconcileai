/**
 * Partner-channel onboarding: WoodCore client → ReconcileAI organization.
 *
 * The WoodCore connector is not just an integration — it is the onboarding
 * bridge for WoodCore's client banks. One call provisions the full tenant:
 *
 *   1. organization        (segment financial_services, onboardingChannel "woodcore")
 *   2. admin user          (invite login, welcome email with magic link)
 *   3. connector config    (their WoodCore connection, disabled until tested)
 *   4. WoodCore channel    (canonical `channels` row their transactions land in)
 *
 * The onboarded institution gets its own org-scoped ReconcileAI interface;
 * super admins can enter it via the portal switcher. Direct clients do NOT go
 * through this path — they are created via superAdmin.createOrganization and
 * keep onboardingChannel "direct".
 *
 * This file is the template for future CBS connectors: each new core-banking
 * connector ships its own onboarding function with the same 4-step contract
 * and its own onboardingChannel code.
 */
import { eq } from "drizzle-orm";
import { organizations, users } from "../../../drizzle/schema";
import { wcConnectorConfigs } from "../../../drizzle/connector_schema";
import { getDb } from "../../db";
import { encryptSecret } from "./secrets";
import { ensureWoodcoreChannel } from "./ingest";

/** Channel code this connector stamps on organizations it onboards. */
export const WOODCORE_ONBOARDING_CHANNEL = "woodcore";

/**
 * Derive a unique-ish org code from the institution name, e.g.
 * "Sunrise Microfinance Bank" → "SUNRISE_MICROFINANCE". Caller still handles
 * uniqueness conflicts (a numeric suffix is appended on collision).
 */
export function deriveOrgCode(name: string): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .split("_")
    .filter(Boolean)
    .slice(0, 3)
    .join("_");
  return (base || "WOODCORE_CLIENT").slice(0, 40);
}

export interface OnboardWoodcoreClientInput {
  /** Institution */
  orgName: string;
  orgCode?: string; // derived from name when omitted
  country?: string; // ISO alpha-3, default NGA
  baseCurrency?: string; // default NGN
  /** First admin of the institution */
  adminName: string;
  adminEmail: string;
  /** Origin for the magic-link welcome email (e.g. https://www.reconcileaiafrica.com) */
  origin?: string;
  /** WoodCore connection (all optional at onboarding; completed later on the connector page) */
  connector?: {
    baseUrl?: string;
    tenantId?: string;
    authMode?: "oauth2" | "api_key" | "basic";
    oauthClientId?: string;
    oauthClientSecret?: string;
    apiKey?: string;
    webhookSecret?: string;
  };
}

export interface OnboardWoodcoreClientResult {
  organizationId: number;
  organizationCode: string;
  adminUserId: number;
  configId: number;
  channelId: number;
  webhookPath: string;
  emailSent: boolean;
  /** Returned so the operator can hand the invite over manually if email is not configured. */
  magicLink: string | null;
}

export class OnboardingError extends Error {
  constructor(
    message: string,
    public readonly code: "DUPLICATE_ORG" | "DUPLICATE_EMAIL" | "DB_UNAVAILABLE",
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

export async function onboardWoodcoreClient(
  input: OnboardWoodcoreClientInput,
): Promise<OnboardWoodcoreClientResult> {
  const db = await getDb();
  if (!db) throw new OnboardingError("Database unavailable", "DB_UNAVAILABLE");

  const email = input.adminEmail.trim().toLowerCase();

  // Pre-flight: email must be free (mirrors admin.addUser behaviour).
  const existingUser = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existingUser.length > 0) {
    throw new OnboardingError(`A user with email ${email} already exists`, "DUPLICATE_EMAIL");
  }

  // 1) Organization — unique code, numeric suffix on collision.
  let code = (input.orgCode?.trim().toUpperCase() || deriveOrgCode(input.orgName)).slice(0, 50);
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.code, code)).limit(1);
    if (clash.length === 0) break;
    if (input.orgCode) {
      // Operator chose the code explicitly — don't silently mutate it.
      throw new OnboardingError(`Organization code ${code} is already in use`, "DUPLICATE_ORG");
    }
    code = `${deriveOrgCode(input.orgName).slice(0, 36)}_${attempt + 2}`;
  }

  const orgRes = await db.insert(organizations).values({
    name: input.orgName.trim(),
    code,
    segment: "financial_services",
    onboardingChannel: WOODCORE_ONBOARDING_CHANNEL,
    country: input.country ?? "NGA",
    baseCurrency: input.baseCurrency ?? "NGN",
    isActive: true,
  });
  const organizationId = Number((orgRes as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
  if (!organizationId) throw new OnboardingError("Failed to create organization", "DB_UNAVAILABLE");

  // 2) Admin user — invite login with synthetic openId (same as admin.addUser).
  const openId = `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const userRes = await db.insert(users).values({
    openId,
    name: input.adminName.trim(),
    email,
    role: "admin",
    organizationId,
    isActive: true,
    loginMethod: "invite",
  });
  const adminUserId = Number((userRes as unknown as [{ insertId: number }])[0]?.insertId ?? 0);

  // 3) Connector config — disabled until the connection test passes.
  const conn = input.connector ?? {};
  const cfgRes = await db.insert(wcConnectorConfigs).values({
    organizationId,
    name: `WoodCore — ${input.orgName.trim()}`.slice(0, 255),
    baseUrl: conn.baseUrl?.trim().replace(/\/+$/, "") ?? "",
    tenantId: conn.tenantId?.trim() || "default",
    authMode: conn.authMode ?? "oauth2",
    oauthClientId: conn.oauthClientId ?? null,
    oauthClientSecretEnc: conn.oauthClientSecret ? encryptSecret(conn.oauthClientSecret) : null,
    apiKeyEnc: conn.apiKey ? encryptSecret(conn.apiKey) : null,
    webhookSecretEnc: conn.webhookSecret ? encryptSecret(conn.webhookSecret) : null,
    isEnabled: false,
  });
  const configId = Number((cfgRes as unknown as [{ insertId: number }])[0]?.insertId ?? 0);

  // 4) Their WoodCore channel in the canonical reconciliation tables.
  const channelId = await ensureWoodcoreChannel(organizationId);

  // Welcome email — best effort; the magic link is returned either way so the
  // operator can hand it over out-of-band when email isn't configured.
  let emailSent = false;
  let magicLink: string | null = null;
  if (adminUserId) {
    try {
      const { sendWelcomeEmail } = await import("../../magicLinkService");
      const origin = input.origin?.trim() || process.env.APP_URL || "";
      if (origin) {
        const r = await sendWelcomeEmail({
          userId: adminUserId,
          name: input.adminName.trim(),
          email,
          role: "admin",
          origin,
        });
        emailSent = r.success;
        magicLink = r.magicLink;
      }
    } catch (err) {
      console.error("[wc-onboarding] welcome email failed:", err);
    }
  }

  return {
    organizationId,
    organizationCode: code,
    adminUserId,
    configId,
    channelId,
    webhookPath: `/api/webhooks/woodcore/${configId}`,
    emailSent,
    magicLink,
  };
}
