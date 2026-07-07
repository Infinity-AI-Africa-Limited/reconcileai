/**
 * Developer documentation page (gap-closure plan WS-4, Phase 5).
 *
 * Served at /developers — Redoc rendering docs/openapi.yaml (exposed at
 * /api/v1/openapi.yaml by the gateway). Domain decision (per the plan's open
 * question): docs live on the production domain at reconcileaiafrica.com/developers
 * rather than a developers.* subdomain — no extra DNS/hosting, works
 * identically on on-prem installs.
 */
export function developerDocsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ReconcileAI Developer API</title>
  <style>
    body { margin: 0; padding: 0; }
    .topbar {
      background: #1B365D; color: #fff; padding: 14px 24px;
      font-family: Inter, system-ui, sans-serif; font-size: 14px;
      display: flex; justify-content: space-between; align-items: center;
    }
    .topbar a { color: #9fc3ff; text-decoration: none; margin-left: 16px; }
    .topbar .brand { font-weight: 700; font-size: 16px; }
  </style>
</head>
<body>
  <div class="topbar">
    <span class="brand">ReconcileAI · Developer API</span>
    <span>
      <a href="/api/v1/openapi.yaml">OpenAPI spec</a>
      <a href="/api/v1/sandbox">Sandbox</a>
      <a href="/">Back to app</a>
    </span>
  </div>
  <redoc spec-url="/api/v1/openapi.yaml"></redoc>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>`;
}
