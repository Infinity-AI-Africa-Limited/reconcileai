# SHOPLINE Billing API Research — Key Findings

## Critical Discovery: SHOPLINE HAS a Built-in App Billing System

Unlike what we assumed earlier (that billing would need to be external via PayPal/Stripe), SHOPLINE **does** have a native app subscription billing system — very similar to Shopify's.

### How It Works

1. **App developer defines plans** in the Partner Portal (during app configuration)
2. **Merchants subscribe** to plans via the SHOPLINE App Store
3. **SHOPLINE handles payment collection** from merchants
4. **SHOPLINE pays developers** via PayPal (minus 15% rev share)
5. **Webhooks notify the app** of subscription lifecycle events

### Webhook Events for Billing

| Event | Topic | Description |
|-------|-------|-------------|
| Plan Activated | `appsubscription/create` | Merchant subscribes or renews |
| Payment Finalized | `appsubscription/paid` | Payment completed (status: 200=success, 300=cancelled, 400=failed) |
| Plan Expired | `appsubscription/expiration` | Plan expired (types: 0=terminated, 1=upgrade, 2=manual cancel, 3=grace period, 4=next cycle activated) |

### Key Fields in `appsubscription/create` Webhook

```json
{
  "appkey": "56978e0b3f33365396d7786a62ed0a03727e3212",
  "handle": "store-handle",
  "subId": "6578332207010012345",
  "subPackage": {
    "spuKey": "premium_plan",        // Plan identifier we define
    "trial": true/false,              // Whether this is a trial
    "autoRenewStatus": true/false,    // Auto-renewal enabled
    "startAt": 1756977716000,         // Start timestamp (ms)
    "endAt": 1757239200000,           // End timestamp (ms)
    "period": 1,                      // Billing cycle count
    "periodType": "MONTH",            // DAY | MONTH | YEAR
    "gracePeriod": 2,                 // Grace period count
    "gracePeriodUnit": "DAY",         // SECOND | DAY
    "featureKeyList": [...],          // Feature keys for plan
    "serviceKeyList": [               // Usage-based services
      {
        "serviceKey": "email_100",
        "totalQty": 100,
        "availableQty": 20,
        "indefinite": false
      }
    ]
  }
}
```

### Key Fields in `appsubscription/paid` Webhook

```json
{
  "appkey": "...",
  "bizOrderNo": "PAY20240726123456",  // Our internal order number
  "handle": "shopline",
  "status": 200,                       // 200=success, 300=cancelled, 400=failed
  "subId": "6578332207010012345",
  "subTime": 1722000000000
}
```

## Implications for ReconcileAI Tier 1

### What This Means

1. **NO external billing integration needed** (no Stripe, no PayPal direct)
2. **SHOPLINE collects payment** from merchants and pays us via PayPal
3. **We define pricing tiers as "plans" (spuKey)** in the Partner Portal
4. **We receive webhooks** for subscription lifecycle management
5. **We track subscription state** in our DB based on webhook events
6. **Grace period handling** is built into the platform

### Plan Configuration (to be set in Partner Portal)

Based on the Tier 1 Pricing Model:

| Plan (spuKey) | Price | Period | Trial | Features |
|---------------|-------|--------|-------|----------|
| `starter` | $29/mo | MONTH | 14 days | ≤500 orders/mo, 1 store |
| `growth` | $79/mo | MONTH | 14 days | ≤2,000 orders/mo, 3 stores |
| `professional` | $149/mo | MONTH | 14 days | ≤10,000 orders/mo, 10 stores |
| `enterprise` | $299/mo | MONTH | 14 days | Unlimited, unlimited stores |
| `enterprise_plus` | $499/mo | MONTH | 14 days | Unlimited + dedicated support |

### Architecture Decision

**Billing module should:**
1. Handle `appsubscription/create`, `appsubscription/paid`, `appsubscription/expiration` webhooks
2. Store subscription state in a new `sl_subscriptions` table
3. Enforce feature gates based on active plan's `spuKey` and `featureKeyList`
4. Track usage (orders/month) against plan limits
5. Show subscription status in merchant dashboard

## App Registration Process (from docs)

1. Log into Partner Portal (developer.myshopline.com)
2. Click "Create Apps" → Select "Public App"
3. Enter: App Name, App URL, Callback URL
4. Obtain APP Key and APP Secret
5. Configure permissions (scopes)
6. Set up webhook subscriptions
7. Configure pricing plans
8. Test with development store
9. Submit for review (1-2 business days)

## Next Steps

- [ ] Log into Partner Portal and register the app
- [ ] Configure the 5 pricing plans
- [ ] Set webhook subscriptions for appsubscription events
- [ ] Build the billing webhook handler
- [ ] Build the subscription state management module
- [ ] Build feature gating middleware
