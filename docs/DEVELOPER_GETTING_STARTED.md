# ReconcileAI Developer API — Getting Started in 5 Minutes

> Interactive reference: **https://www.reconcileaiafrica.com/developers** ·
> Spec: `/api/v1/openapi.yaml` · Base URL: `https://www.reconcileaiafrica.com/api/v1`
> (identical paths on on-premise installs: `https://<your-host>/api/v1`)

## Minute 1 — your first call, no API key

The sandbox runs ReconcileAI's **real matching engine** on a deterministic
synthetic dataset — same output every time, perfect for integration tests.

```bash
curl -X POST https://www.reconcileaiafrica.com/api/v1/sandbox/reconciliation/runs
```

You get back a complete run: matched pairs (exact / tolerance / date-window),
a detected duplicate, an unmatched leg, a fee-deducted amount mismatch, and a
cross-currency FX pair classified as `fx_rate_variance` with the implied rate
cited — the same shapes the authenticated endpoints return.

## Minute 2 — get an API key

Dashboard → **Admin → API Keys → Create**. The key is shown once — store it
safely. API requests act as your user: same role permissions, same audit trail.

```bash
export RECONCILEAI_API_KEY="rk_..."
export BASE="https://www.reconcileaiafrica.com/api/v1"
```

## Minute 3 — trigger a reconciliation run

```bash
curl -X POST "$BASE/reconciliation/runs" \
  -H "X-API-Key: $RECONCILEAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "June NIP vs CBS",
    "sourceChannelId": 1,
    "targetChannelId": 2,
    "dateFrom": "2026-06-01",
    "dateTo": "2026-06-30"
  }'
# → 202 { "runId": 123, "status": "pending" }
```

Runs are asynchronous. Poll `GET /reconciliation/runs/123`, or register a
webhook for `reconciliation.completed` (Dashboard → Integrations → Webhooks).

## Minute 4 — work the exceptions

```bash
# Open exceptions for the run
curl "$BASE/exceptions?runId=123&status=open" -H "X-API-Key: $RECONCILEAI_API_KEY"

# Resolve one (feeds the learning flywheel — your note trains future recommendations)
curl -X PATCH "$BASE/exceptions/456" \
  -H "X-API-Key: $RECONCILEAI_API_KEY" -H "Content-Type: application/json" \
  -d '{"status": "resolved", "resolutionNote": "Fee variance posted to charges GL"}'
```

## Minute 5 — ask the intelligence layer

```bash
# How has this category been resolved before — by you, and by the network?
curl "$BASE/intelligence/recommendations?category=amount_mismatch" \
  -H "X-API-Key: $RECONCILEAI_API_KEY"

# AI diagnosis for an exception payload
curl -X POST "$BASE/intelligence/diagnose" \
  -H "X-API-Key: $RECONCILEAI_API_KEY" -H "Content-Type: application/json" \
  -d '{"category": "fx_rate_variance", "amount": 1520000, "currency": "NGN",
       "description": "USD leg settled at a different rate"}'
```

---

## JavaScript (Node 18+)

```js
const BASE = "https://www.reconcileaiafrica.com/api/v1";
const headers = {
  "X-API-Key": process.env.RECONCILEAI_API_KEY,
  "Content-Type": "application/json",
};

// Trigger a run
const run = await fetch(`${BASE}/reconciliation/runs`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    sourceChannelId: 1,
    targetChannelId: 2,
    dateFrom: "2026-06-01",
    dateTo: "2026-06-30",
  }),
}).then((r) => r.json());

// Poll until completed
let detail;
do {
  await new Promise((r) => setTimeout(r, 3000));
  detail = await fetch(`${BASE}/reconciliation/runs/${run.runId}`, { headers }).then((r) => r.json());
} while (detail.status === "pending" || detail.status === "running");

console.log(`${detail.matchRate}% matched, ${detail.exceptionCount} exceptions`);
```

## Python (3.10+, requests)

```python
import os, time, requests

BASE = "https://www.reconcileaiafrica.com/api/v1"
H = {"X-API-Key": os.environ["RECONCILEAI_API_KEY"]}

run = requests.post(f"{BASE}/reconciliation/runs", headers=H, json={
    "sourceChannelId": 1, "targetChannelId": 2,
    "dateFrom": "2026-06-01", "dateTo": "2026-06-30",
}).json()

while True:
    detail = requests.get(f"{BASE}/reconciliation/runs/{run['runId']}", headers=H).json()
    if detail["status"] not in ("pending", "running"):
        break
    time.sleep(3)

for exc in requests.get(f"{BASE}/exceptions", headers=H,
                        params={"runId": run["runId"], "status": "open"}).json()["data"]:
    print(exc["category"], exc["severity"], exc["description"])
```

## Verifying webhook signatures

Every delivery is signed with your webhook's secret (shown once at creation):

```js
import crypto from "node:crypto";

function verify(rawBody, signatureHeader, secret) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
```

Deliveries retry with exponential backoff (6 attempts). Respond `2xx` quickly;
do the work asynchronously. Delivery history: Dashboard → Integrations → Webhooks.

## Rate limits & errors

- 60 requests/minute per API key (sandbox: 30/minute per IP); `429` carries `Retry-After`.
- Errors are `{ "code": "...", "message": "..." }` with conventional HTTP statuses
  (`401` bad key, `403` role/scope, `404` not found or out of scope, `400` validation).

*Gap-closure plan WS-4 deliverable — July 2026.*
