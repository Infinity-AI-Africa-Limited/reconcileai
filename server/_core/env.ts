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
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  // Direct LLM provider (production / Rocket.new / self-hosted)
  // Set DIRECT_LLM_API_KEY to switch away from Manus Forge.
  directLlmApiKey: process.env.DIRECT_LLM_API_KEY ?? "",
  directLlmApiUrl: process.env.DIRECT_LLM_API_URL ?? "",   // base URL, e.g. https://api.anthropic.com or https://api.openai.com
  directLlmModel: process.env.DIRECT_LLM_MODEL ?? "",       // e.g. claude-sonnet-4-5, gpt-4o
  // Optional explicit provider selector: "anthropic" | "openai". When empty, auto-detected
  // from the model name ("claude…" → anthropic) or the URL (contains "anthropic").
  directLlmProvider: (process.env.DIRECT_LLM_PROVIDER ?? "").toLowerCase(),
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
  // Woodcore (Fineract) test tenant
  woodcoreDbHost: process.env.WOODCORE_DB_HOST ?? "",
  woodcoreDbPort: parseInt(process.env.WOODCORE_DB_PORT ?? "3306", 10),
  woodcoreDbUser: process.env.WOODCORE_DB_USER ?? "",
  woodcoreDbPassword: process.env.WOODCORE_DB_PASSWORD ?? "",
  woodcoreDbName: process.env.WOODCORE_DB_NAME ?? "",
};
