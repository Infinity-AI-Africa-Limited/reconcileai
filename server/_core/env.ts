/**
 * Trim whitespace and strip a single pair of surrounding quotes from a secret/URL.
 * Hosting dashboards and quoted .env entries frequently introduce a trailing
 * newline or wrapping quotes, which would otherwise be sent verbatim — e.g. as the
 * Anthropic `x-api-key`, producing a 401 "invalid x-api-key". Correctly-set values
 * are unaffected.
 */
function cleanSecret(v: string | undefined): string {
  let s = (v ?? "").trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  // Data-residency posture. "on_premise" enforces that no transaction data leaves
  // the deployment: all outbound calls are blocked except to loopback/private hosts
  // and EGRESS_ALLOWLIST. "cloud" (default) keeps today's behaviour (internet LLM, etc.).
  deploymentMode: (process.env.DEPLOYMENT_MODE ?? "cloud").toLowerCase(),
  // Comma-separated hostnames explicitly permitted to receive outbound calls in
  // on_premise mode (e.g. an in-VPC LLM gateway, or the Exception Intelligence pool).
  egressAllowlist: process.env.EGRESS_ALLOWLIST ?? "",
  forgeApiUrl: cleanSecret(process.env.BUILT_IN_FORGE_API_URL),
  forgeApiKey: cleanSecret(process.env.BUILT_IN_FORGE_API_KEY),
  // Direct LLM provider (production / Rocket.new / self-hosted)
  // Set DIRECT_LLM_API_KEY to switch away from Manus Forge.
  // cleanSecret guards against the #1 cause of 401 "invalid x-api-key": a key
  // pasted with surrounding quotes or a trailing newline in the hosting dashboard.
  directLlmApiKey: cleanSecret(process.env.DIRECT_LLM_API_KEY),
  directLlmApiUrl: cleanSecret(process.env.DIRECT_LLM_API_URL),   // base URL, e.g. https://api.anthropic.com or https://api.openai.com
  directLlmModel: cleanSecret(process.env.DIRECT_LLM_MODEL),       // e.g. claude-sonnet-4-5, gpt-4o
  // Optional explicit provider selector: "anthropic" | "openai". When empty, auto-detected
  // from the model name ("claude…" → anthropic) or the URL (contains "anthropic").
  directLlmProvider: cleanSecret(process.env.DIRECT_LLM_PROVIDER).toLowerCase(),
  // Transactional email (Resend). When unset, email sending is a no-op (logs a warning).
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "",                 // e.g. noreply@reconcileai.vip
  emailFromName: process.env.EMAIL_FROM_NAME ?? "ReconcileAI",
  ownerEmail: process.env.OWNER_EMAIL ?? "",               // recipient for owner/system notifications
  appUrl: process.env.APP_URL ?? "",                       // canonical app origin, e.g. https://reconcileai.vip
  // Shared secret guarding maintenance/cron endpoints (e.g. Woodcore mirror sync).
  // Falls back to JWT_SECRET when unset, so no extra var is strictly required.
  cronSecret: process.env.CRON_SECRET ?? "",
  // Ed25519 PKCS#8 PEM private key used to digitally sign CBN examination reports.
  // When unset, an ephemeral key is generated per-process (dev/demo only).
  cbnSigningPrivateKey: process.env.CBN_SIGNING_PRIVATE_KEY ?? "",
  // ReconcileAI Exception Intelligence pool endpoint. Receives ONLY anonymized,
  // non-personal pattern signatures. On-prem: this is the single allowlisted
  // egress (add its host to EGRESS_ALLOWLIST). Unset → local-only (no sync).
  exceptionIntelEndpoint: process.env.EXCEPTION_INTEL_ENDPOINT ?? "",
  // File storage — AWS S3 or S3-compatible (Cloudflare R2). Replaces the Manus storage proxy.
  // Tolerates both AWS_S3_* and the alternate names used across the docs.
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
  awsRegion: process.env.AWS_REGION ?? "auto",
  awsS3Bucket: process.env.AWS_S3_BUCKET ?? process.env.AWS_BUCKET_NAME ?? "",
  awsS3Endpoint: process.env.AWS_S3_ENDPOINT ?? process.env.AWS_ENDPOINT_URL ?? "", // set for R2 / S3-compatible
  // ── Per-tenant encryption key management ──────────────────────────────────
  // Master-key provider that wraps each tenant's Data Encryption Key:
  //   "local"   — AES-256-GCM wrap under TENANT_MASTER_KEY (on-prem/air-gap, default)
  //   "aws_kms" — AWS KMS GenerateDataKey/Decrypt (requires @aws-sdk/client-kms
  //               installed, TENANT_KMS_KEY_ID, and the AWS_* credentials)
  tenantKeyProvider: (process.env.TENANT_KEY_PROVIDER ?? "local").toLowerCase(),
  // 64 hex chars. When unset, derived from JWT_SECRET (deterministic across
  // restarts) — set a dedicated key in production.
  tenantMasterKey: cleanSecret(process.env.TENANT_MASTER_KEY),
  tenantKmsKeyId: cleanSecret(process.env.TENANT_KMS_KEY_ID),
  // ── Enterprise SSO (both optional; buttons appear on /login when configured) ──
  // Google OAuth2 — fintechs/startups on Google Workspace.
  // Redirect URI to register: <APP_URL>/api/oauth/google/callback
  googleClientId: cleanSecret(process.env.GOOGLE_CLIENT_ID),
  googleClientSecret: cleanSecret(process.env.GOOGLE_CLIENT_SECRET),
  // Microsoft Entra ID (Azure AD) OAuth2 — commercial banks on Microsoft 365.
  // Redirect URI to register: <APP_URL>/api/oauth/microsoft/callback
  microsoftClientId: cleanSecret(process.env.MICROSOFT_CLIENT_ID),
  microsoftClientSecret: cleanSecret(process.env.MICROSOFT_CLIENT_SECRET),
  // Entra tenant: "common" (any org), "organizations", or a specific tenant GUID.
  microsoftTenantId: cleanSecret(process.env.MICROSOFT_TENANT_ID) || "common",
  // Woodcore (Fineract) test tenant
  woodcoreDbHost: process.env.WOODCORE_DB_HOST ?? "",
  woodcoreDbPort: parseInt(process.env.WOODCORE_DB_PORT ?? "3306", 10),
  woodcoreDbUser: process.env.WOODCORE_DB_USER ?? "",
  woodcoreDbPassword: process.env.WOODCORE_DB_PASSWORD ?? "",
  woodcoreDbName: process.env.WOODCORE_DB_NAME ?? "",
  // ── SHOPLINE App Store connector (set in SHOPLINE Partner Portal) ──────────
  // App key and app secret are obtained after creating a Public app in the
  // SHOPLINE Developer Center. Required for OAuth install, token refresh,
  // and webhook HMAC verification.
  shoplineAppKey: cleanSecret(process.env.SHOPLINE_APP_KEY),
  shoplineAppSecret: cleanSecret(process.env.SHOPLINE_APP_SECRET),
  /**
   * Verbose (but REDACTED) signature diagnostics for the SHOPLINE OAuth GET
   * routes. Logs which candidate encoding matched, the signed message with
   * sensitive values masked, and signature PREFIXES only — never secret
   * material. Off unless explicitly set to "true"/"1".
   */
  shoplineSigDebug: /^(1|true)$/i.test(process.env.SHOPLINE_SIG_DEBUG ?? ""),
};
