# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# ReconcileAI — on-premise application image (Option 3 / Option 2)
#
# Multi-stage build:
#   builder  → installs all deps and runs `pnpm build` (vite + esbuild → dist/)
#   runtime  → slim image that only runs `node dist/index.js`
#
# Build this on a machine WITH internet (ReconcileAI side), then ship the
# resulting image (`docker save | docker load`) to the air-gapped client.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm AS builder
WORKDIR /app
RUN corepack enable
# Install deps first for layer caching
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
# Build frontend (vite → dist/public) and backend (esbuild → dist/index.js)
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# The server bundle externalises packages, so node_modules are needed at runtime.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/drizzle ./drizzle
# Migrations run in-container via `npx drizzle-kit migrate` (the slim runtime has
# no pnpm); drizzle-kit needs the config, and first-login on an air-gapped box
# needs scripts/bootstrap-admin.mjs.
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/scripts ./scripts
EXPOSE 3000
# Liveness: the app exposes GET /api/healthz (200 when the process is up).
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
