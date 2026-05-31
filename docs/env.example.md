# ReconcileAI — Environment Variables Reference

This file documents all environment variables required to run ReconcileAI in production.
Copy and adapt these for your hosting platform (Rocket.new secrets panel, Railway, etc.).
**Never commit real secrets to version control.**

## Database

```bash
DATABASE_URL=mysql://user:password@host:4000/reconcileai?ssl={"rejectUnauthorized":true}
```
MySQL-compatible connection string. Supported: TiDB Cloud, PlanetScale, AWS RDS MySQL, Supabase (MySQL mode).

## Authentication

```bash
JWT_SECRET=<32+ character random string>
# Generate: openssl rand -hex 32
```
Used to sign and verify JWT session cookies. Must be kept secret and rotated if compromised.

> **Manus-specific variables to REMOVE in production:**
> `VITE_APP_ID`, `OAUTH_SERVER_URL`, `VITE_OAUTH_PORTAL_URL`, `BUILT_IN_FORGE_API_KEY`,
> `BUILT_IN_FORGE_API_URL`, `VITE_FRONTEND_FORGE_API_KEY`, `VITE_FRONTEND_FORGE_API_URL`

## LLM Provider (replaces Manus Forge)

```bash
DIRECT_LLM_API_KEY=sk-...
DIRECT_LLM_API_URL=https://api.openai.com/v1/chat/completions
DIRECT_LLM_MODEL=gpt-4o-mini
```

When `DIRECT_LLM_API_KEY` is set, the Manus Forge gateway is bypassed automatically — no code changes needed.

| Provider | API URL | Model |
|---|---|---|
| OpenAI (recommended) | `https://api.openai.com/v1/chat/completions` | `gpt-4o-mini` or `gpt-4o` |
| Anthropic | `https://api.anthropic.com/v1/messages` | `claude-3-5-sonnet-20241022` |
| Google (via OpenAI compat) | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.0-flash` |

**Note for Anthropic:** The current `server/_core/llm.ts` uses OpenAI message format. If using Anthropic directly, either use a proxy (LiteLLM) or update the helper to handle Anthropic's format.

## File Storage (AWS S3 or S3-compatible)

```bash
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_REGION=af-south-1
AWS_S3_BUCKET=reconcileai-prod
```

For **Cloudflare R2** (recommended — no egress fees):
```bash
AWS_ACCESS_KEY_ID=<r2-access-key>
AWS_SECRET_ACCESS_KEY=<r2-secret-key>
AWS_REGION=auto
AWS_S3_BUCKET=reconcileai-prod
AWS_S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
```

## Email Delivery

```bash
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@reconcileai.vip
EMAIL_FROM_NAME=ReconcileAI
```

Resend is recommended. Requires SPF, DKIM, and DMARC records on `reconcileai.vip`.
Alternative: `SENDGRID_API_KEY=SG....`

## Application

```bash
NODE_ENV=production
PORT=3000
APP_URL=https://reconcileai.vip
```

## SFTP Credential Encryption

```bash
SFTP_ENCRYPTION_KEY=<32-character random string>
# Generate: openssl rand -hex 32
```

Used to encrypt SFTP credentials stored in the `sftp_credentials` database table.

## Woodcore Integration (pending IP whitelist)

```bash
WOODCORE_API_URL=
WOODCORE_CLIENT_ID=
WOODCORE_CLIENT_SECRET=
WOODCORE_TENANT_ID=
```

Leave blank until Woodcore whitelists the production server's IP address.

## Analytics (optional)

```bash
VITE_POSTHOG_KEY=phc_...
VITE_POSTHOG_HOST=https://app.posthog.com
```

Replace Manus analytics (`VITE_ANALYTICS_ENDPOINT`, `VITE_ANALYTICS_WEBSITE_ID`) with PostHog or Plausible.

## Error Monitoring (optional)

```bash
SENTRY_DSN=https://...@sentry.io/...
VITE_SENTRY_DSN=https://...@sentry.io/...
```
