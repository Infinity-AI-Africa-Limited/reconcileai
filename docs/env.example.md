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
# Recommended: Anthropic Claude (native Messages API adapter)
DIRECT_LLM_API_KEY=sk-ant-...
DIRECT_LLM_API_URL=https://api.anthropic.com
DIRECT_LLM_MODEL=claude-sonnet-4-5
# Optional explicit selector: "anthropic" | "openai".
# Auto-detected from the model name ("claude…") or URL when omitted.
DIRECT_LLM_PROVIDER=anthropic
```

When `DIRECT_LLM_API_KEY` is set, the Manus Forge gateway is bypassed automatically.
`DIRECT_LLM_API_URL` is a **base URL** — the correct path (`/v1/messages` for Anthropic,
`/v1/chat/completions` for OpenAI) is appended for you. Values that already include a
trailing `/v1` or the full path are also accepted.

| Provider | `DIRECT_LLM_API_URL` (base) | Model |
|---|---|---|
| Anthropic (recommended) | `https://api.anthropic.com` | `claude-sonnet-4-5` (Super Agent: `claude-opus-4`) |
| OpenAI | `https://api.openai.com` | `gpt-4o-mini` or `gpt-4o` |
| OpenAI-compatible proxy (LiteLLM) | `https://your-litellm-proxy.com` | provider-prefixed model |

**Anthropic is now first-class:** `server/_core/llm.ts` ships a **native Anthropic Messages
adapter** (no LiteLLM proxy required). It translates the OpenAI-shaped request/response so all
existing call sites are unchanged, and maps structured-output requests (`response_format` /
`outputSchema`) onto Anthropic tool-use automatically.

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
# Recipient for platform-owner / system notifications (digests, fallbacks).
# Falls back to EMAIL_FROM when unset.
OWNER_EMAIL=ops@reconcileai.vip
```

Resend is recommended. Requires SPF, DKIM, and DMARC records on `reconcileai.vip`.
All transactional email (magic-link sign-in, user invites, CFO scheduled reports with
Excel attachment, channel-threshold alerts, owner notifications) routes through Resend
via `server/_core/email.ts`. **If `RESEND_API_KEY` / `EMAIL_FROM` are unset, email sending
is a safe no-op (logged, never throws)** — sign-in links will not be delivered, so set these
before onboarding external users.

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
