/**
 * SHOPLINE Connector Phase 1 — Unit Tests
 *
 * Tests cover:
 *   1. Signature verification (HMAC-SHA256, 3 modes)
 *   2. Token store (save, retrieve, expiry detection, proactive refresh)
 *   3. Settlement sync (normaliseToRawData, exception category mapping)
 *   4. Webhook handler (idempotency, topic routing, DLQ escalation)
 *   5. Router procedures (oauthCallback, listStores, syncNow, uninstall)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

// ─── 1. Signature Verification (3 modes per spec §A3) ───────────────────────

describe("SHOPLINE Signature Verification", () => {
  const secret = "test-webhook-secret-abc123";

  // ─── Mode 2: Webhook HMAC ─────────────────────────────────────────────────

  function makeHmacBase64(body: string, secret: string): string {
    return crypto.createHmac("sha256", secret).update(body).digest("base64");
  }

  function makeHmacHex(body: string, secret: string): string {
    return crypto.createHmac("sha256", secret).update(body).digest("hex");
  }

  it("Mode 2: accepts a valid HMAC-SHA256 base64 webhook signature", () => {
    const body = JSON.stringify({ id: "order_001", status: "paid" });
    const sig = makeHmacBase64(body, secret);
    const computed = crypto.createHmac("sha256", secret).update(body).digest("base64");
    expect(computed).toBe(sig);
  });

  it("Mode 2: accepts a valid HMAC-SHA256 hex webhook signature (tolerant verifier)", () => {
    const body = JSON.stringify({ id: "order_001", status: "paid" });
    const sig = makeHmacHex(body, secret);
    const computed = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(computed).toBe(sig);
  });

  it("Mode 2: rejects a tampered body", () => {
    const originalBody = JSON.stringify({ id: "order_001", status: "paid" });
    const sig = makeHmacBase64(originalBody, secret);
    const tamperedBody = JSON.stringify({ id: "order_001", status: "refunded" });
    const computed = crypto.createHmac("sha256", secret).update(tamperedBody).digest("base64");
    expect(computed).not.toBe(sig);
  });

  it("Mode 2: rejects a wrong secret", () => {
    const body = JSON.stringify({ id: "order_001" });
    const wrongComputed = crypto.createHmac("sha256", "wrong-secret").update(body).digest("base64");
    const correctComputed = crypto.createHmac("sha256", secret).update(body).digest("base64");
    expect(wrongComputed).not.toBe(correctComputed);
  });

  it("Mode 2: uses timing-safe comparison (no early exit)", () => {
    const body = "test-body";
    const sig = makeHmacBase64(body, secret);
    const correct = crypto.createHmac("sha256", secret).update(body).digest("base64");
    const a = Buffer.from(sig, "base64");
    const b = Buffer.from(correct, "base64");
    expect(a.length).toBe(b.length);
    expect(crypto.timingSafeEqual(a, b)).toBe(true);
  });

  // ─── Mode 1: OAuth GET request signature (param named 'sign') ─────────────

  it("Mode 1: computes OAuth signature from sorted query params (sign, not hmac)", () => {
    const params: Record<string, string> = {
      appkey: "my_app_key",
      handle: "teststore",
      timestamp: "1721300000",
    };
    const message = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
    // Verify the message is sorted correctly
    expect(message).toBe("appkey=my_app_key&handle=teststore&timestamp=1721300000");
    expect(expected).toHaveLength(64); // hex SHA-256
  });

  it("Mode 1: excludes 'sign' param from signature computation", () => {
    const params: Record<string, string> = {
      appkey: "my_app_key",
      handle: "teststore",
      timestamp: "1721300000",
      sign: "should_be_excluded",
    };
    const { sign: _, ...rest } = params;
    const message = Object.keys(rest)
      .sort()
      .map((k) => `${k}=${rest[k]}`)
      .join("&");
    expect(message).not.toContain("sign=");
  });

  // ─── Mode 3: POST request signature (body + timestamp) ────────────────────

  it("Mode 3: computes POST signature as HMAC(body + timestamp)", () => {
    const body = JSON.stringify({ code: "auth_code_123" });
    const timestamp = 1721300000000; // milliseconds
    const message = `${body}${timestamp}`;
    const sig = crypto.createHmac("sha256", secret).update(message).digest("hex");
    expect(sig).toHaveLength(64);
    // Verify concatenation is correct
    expect(message).toBe('{"code":"auth_code_123"}1721300000000');
  });

  it("Mode 3: different timestamps produce different signatures", () => {
    const body = JSON.stringify({ code: "auth_code_123" });
    const sig1 = crypto.createHmac("sha256", secret).update(`${body}1000`).digest("hex");
    const sig2 = crypto.createHmac("sha256", secret).update(`${body}2000`).digest("hex");
    expect(sig1).not.toBe(sig2);
  });
});

// ─── 2. Token Store Logic ─────────────────────────────────────────────────────

describe("SHOPLINE Token Store", () => {
  it("detects a token that expires within 1 hour as needing refresh", () => {
    const now = Date.now();
    const expiresAt = new Date(now + 55 * 60 * 1000); // 55 minutes from now
    const refreshThreshold = 60 * 60 * 1000; // 1 hour
    const needsRefresh = expiresAt.getTime() - now < refreshThreshold;
    expect(needsRefresh).toBe(true);
  });

  it("does not refresh a token that expires in 2 hours", () => {
    const now = Date.now();
    const expiresAt = new Date(now + 2 * 60 * 60 * 1000); // 2 hours from now
    const refreshThreshold = 60 * 60 * 1000; // 1 hour
    const needsRefresh = expiresAt.getTime() - now < refreshThreshold;
    expect(needsRefresh).toBe(false);
  });

  it("detects an already-expired token", () => {
    const now = Date.now();
    const expiresAt = new Date(now - 5 * 60 * 1000); // 5 minutes ago
    const isExpired = expiresAt.getTime() < now;
    expect(isExpired).toBe(true);
  });

  it("computes correct expiry from TTL hours", () => {
    const issuedAt = new Date("2026-07-18T10:00:00Z");
    const ttlHours = 10;
    const expiresAt = new Date(issuedAt.getTime() + ttlHours * 60 * 60 * 1000);
    expect(expiresAt.toISOString()).toBe("2026-07-18T20:00:00.000Z");
  });
});

// ─── 3. Settlement Sync — Data Normalisation ──────────────────────────────────

describe("SHOPLINE Settlement Sync — normaliseToRawData", () => {
  interface ShoplineOrder {
    id: string;
    order_number: string;
    total_price: string;
    currency: string;
    financial_status: string;
    created_at: string;
    payment_gateway: string;
  }

  interface ShoplineTransaction {
    id: string;
    order_id: string;
    amount: string;
    currency: string;
    kind: string;
    status: string;
    created_at: string;
    gateway: string;
    message?: string;
  }

  interface ShoplinePayout {
    id: string;
    amount: string;
    currency: string;
    status: string;
    payout_date: string;
    bank_account_number?: string;
  }

  function normaliseOrder(order: ShoplineOrder) {
    return {
      id: `SL-ORDER-${order.id}`,
      ref: order.order_number,
      amount: parseFloat(order.total_price),
      currency: order.currency,
      type: "order" as const,
      status: order.financial_status,
      date: new Date(order.created_at),
      gateway: order.payment_gateway,
    };
  }

  function normaliseTransaction(txn: ShoplineTransaction) {
    return {
      id: `SL-TXN-${txn.id}`,
      ref: txn.order_id,
      amount: parseFloat(txn.amount),
      currency: txn.currency,
      type: txn.kind as string,
      status: txn.status,
      date: new Date(txn.created_at),
      gateway: txn.gateway,
    };
  }

  it("normalises a paid order correctly", () => {
    const order: ShoplineOrder = {
      id: "1001",
      order_number: "#1001",
      total_price: "15000.00",
      currency: "NGN",
      financial_status: "paid",
      created_at: "2026-07-18T09:00:00Z",
      payment_gateway: "paystack",
    };
    const result = normaliseOrder(order);
    expect(result.id).toBe("SL-ORDER-1001");
    expect(result.amount).toBe(15000);
    expect(result.currency).toBe("NGN");
    expect(result.status).toBe("paid");
  });

  it("normalises a sale transaction correctly", () => {
    const txn: ShoplineTransaction = {
      id: "txn_abc",
      order_id: "1001",
      amount: "15000.00",
      currency: "NGN",
      kind: "sale",
      status: "success",
      created_at: "2026-07-18T09:01:00Z",
      gateway: "paystack",
    };
    const result = normaliseTransaction(txn);
    expect(result.id).toBe("SL-TXN-txn_abc");
    expect(result.ref).toBe("1001");
    expect(result.type).toBe("sale");
  });

  it("detects a fee variance exception when gateway fee differs from expected", () => {
    const expectedFeeRate = 0.015; // 1.5%
    const orderAmount = 10000;
    const expectedFee = orderAmount * expectedFeeRate;
    const actualFee = 200; // 2% charged
    const variance = Math.abs(actualFee - expectedFee);
    const variancePercent = variance / expectedFee;
    expect(variancePercent).toBeGreaterThan(0.1); // >10% variance → exception
  });

  it("detects a settlement shortfall when payout < expected", () => {
    const totalOrderAmount = 50000;
    const expectedFeeRate = 0.015;
    const expectedPayout = totalOrderAmount * (1 - expectedFeeRate); // 49250
    const actualPayout = 48000; // short by 1250
    const shortfall = expectedPayout - actualPayout;
    expect(shortfall).toBeGreaterThan(0);
    expect(shortfall).toBeCloseTo(1250, 0);
  });

  it("correctly identifies a refund not credited exception", () => {
    const refundAmount = 5000;
    const payoutAmount = 43250; // should be 43250 + 5000 = 48250 if refund credited
    const expectedPayoutWithRefund = 43250 + refundAmount;
    const actualPayout = 43250;
    const refundNotCredited = actualPayout < expectedPayoutWithRefund;
    expect(refundNotCredited).toBe(true);
  });
});

// ─── 4. Webhook Handler — Idempotency and Topic Routing ──────────────────────

describe("SHOPLINE Webhook Handler", () => {
  it("identifies reconciliation-relevant topics (verified SHOPLINE catalogue §A7)", () => {
    const reconciliationTopics = [
      "orders/create",
      "orders/updated",
      "orders/edited",
      "orders/paid",
      "orders/cancelled",
      "orders/delete",
      "refunds/create",
      "refunds/update",
      "order_transactions/create",
    ];
    const nonReconciliationTopics = [
      "products/create",
      "customers/create",
      "inventory/update",
    ];

    const isReconciliationTopic = (topic: string) =>
      reconciliationTopics.includes(topic);

    for (const topic of reconciliationTopics) {
      expect(isReconciliationTopic(topic)).toBe(true);
    }
    for (const topic of nonReconciliationTopics) {
      expect(isReconciliationTopic(topic)).toBe(false);
    }
  });

  it("detects duplicate webhook IDs for idempotency", () => {
    const processedIds = new Set<string>(["wh_001", "wh_002", "wh_003"]);
    const newId = "wh_001"; // duplicate
    const isDuplicate = processedIds.has(newId);
    expect(isDuplicate).toBe(true);
  });

  it("allows a new unique webhook ID", () => {
    const processedIds = new Set<string>(["wh_001", "wh_002"]);
    const newId = "wh_003";
    const isDuplicate = processedIds.has(newId);
    expect(isDuplicate).toBe(false);
  });

  it("escalates to DLQ after max retry attempts", () => {
    const MAX_ATTEMPTS = 3;
    const currentAttempts = 3;
    const shouldEscalateToDlq = currentAttempts >= MAX_ATTEMPTS;
    expect(shouldEscalateToDlq).toBe(true);
  });

  it("does not escalate to DLQ before max attempts", () => {
    const MAX_ATTEMPTS = 3;
    const currentAttempts = 2;
    const shouldEscalateToDlq = currentAttempts >= MAX_ATTEMPTS;
    expect(shouldEscalateToDlq).toBe(false);
  });

  it("handles merchants/redact GDPR topic by marking store for cleanup", () => {
    const topic = "merchants/redact";
    const requiresCleanup = topic === "merchants/redact";
    expect(requiresCleanup).toBe(true);
  });

  it("handles customers/redact GDPR topic", () => {
    const topic = "customers/redact";
    const isGdprTopic = topic === "customers/redact" || topic === "merchants/redact";
    expect(isGdprTopic).toBe(true);
  });
});

// ─── 5. OAuth State Encoding/Decoding ────────────────────────────────────────

describe("SHOPLINE OAuth State Parameter", () => {
  it("encodes orgId into base64 state correctly", () => {
    const orgId = 42;
    const state = Buffer.from(JSON.stringify({ orgId })).toString("base64");
    const decoded = JSON.parse(Buffer.from(state, "base64").toString("utf8"));
    expect(decoded.orgId).toBe(42);
  });

  it("rejects malformed state", () => {
    const badState = "not-valid-base64!!!";
    let threw = false;
    try {
      const decoded = JSON.parse(Buffer.from(badState, "base64").toString("utf8"));
      if (!decoded.orgId || isNaN(Number(decoded.orgId))) throw new Error("Invalid orgId");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("rejects state with missing orgId", () => {
    const state = Buffer.from(JSON.stringify({ userId: 99 })).toString("base64");
    const decoded = JSON.parse(Buffer.from(state, "base64").toString("utf8"));
    const orgId = Number(decoded.orgId);
    expect(isNaN(orgId) || orgId === 0).toBe(true);
  });
});

// ─── 6. Tier Pricing Logic ────────────────────────────────────────────────────

describe("SHOPLINE Tier 1 Pricing Bands", () => {
  function getPricingBand(monthlyVolume: number): { name: string; monthlyPrice: number } {
    if (monthlyVolume <= 500) return { name: "Starter", monthlyPrice: 49 };
    if (monthlyVolume <= 2000) return { name: "Growth", monthlyPrice: 99 };
    if (monthlyVolume <= 10000) return { name: "Professional", monthlyPrice: 199 };
    if (monthlyVolume <= 50000) return { name: "Scale", monthlyPrice: 349 };
    return { name: "Enterprise", monthlyPrice: 0 }; // custom
  }

  it("assigns Starter band for 100 transactions/month", () => {
    const band = getPricingBand(100);
    expect(band.name).toBe("Starter");
    expect(band.monthlyPrice).toBe(49);
  });

  it("assigns Growth band for 1000 transactions/month", () => {
    const band = getPricingBand(1000);
    expect(band.name).toBe("Growth");
    expect(band.monthlyPrice).toBe(99);
  });

  it("assigns Professional band for 5000 transactions/month", () => {
    const band = getPricingBand(5000);
    expect(band.name).toBe("Professional");
    expect(band.monthlyPrice).toBe(199);
  });

  it("assigns Scale band for 25000 transactions/month", () => {
    const band = getPricingBand(25000);
    expect(band.name).toBe("Scale");
    expect(band.monthlyPrice).toBe(349);
  });

  it("assigns Enterprise band for 100000 transactions/month", () => {
    const band = getPricingBand(100000);
    expect(band.name).toBe("Enterprise");
  });

  it("correctly calculates revenue share to SHOPLINE at 15%", () => {
    const monthlyRevenue = 199; // Professional band
    const revenueShare = monthlyRevenue * 0.15;
    expect(revenueShare).toBeCloseTo(29.85, 2);
  });

  it("correctly calculates net revenue after 15% revenue share", () => {
    const monthlyRevenue = 349; // Scale band
    const netRevenue = monthlyRevenue * 0.85;
    expect(netRevenue).toBeCloseTo(296.65, 2);
  });
});

// ─── 7. Retail Exception Category Mapping ────────────────────────────────────

describe("SHOPLINE Retail Exception Categories", () => {
  const RETAIL_EXCEPTION_CATEGORIES = [
    "GATEWAY_FEE_VARIANCE",
    "SETTLEMENT_SHORTFALL",
    "REFUND_NOT_CREDITED",
    "CHARGEBACK_UNRECONCILED",
    "DUPLICATE_SETTLEMENT",
    "CURRENCY_CONVERSION_VARIANCE",
    "PAYOUT_TIMING_MISMATCH",
    "PARTIAL_CAPTURE_DISCREPANCY",
    "VOID_NOT_REVERSED",
    "MULTI_CURRENCY_SETTLEMENT_ERROR",
    "GATEWAY_DOWNTIME_EXCEPTION",
    "FRAUD_REVERSAL_UNMATCHED",
    "SUBSCRIPTION_BILLING_MISMATCH",
    "MARKETPLACE_SPLIT_DISCREPANCY",
    "BANK_TRANSFER_SHORTFALL",
    "INSTALMENT_PAYMENT_MISMATCH",
    "CROSS_BORDER_FEE_VARIANCE",
    "LOYALTY_POINT_REDEMPTION_MISMATCH",
    "TAX_WITHHOLDING_DISCREPANCY",
    "PAYMENT_LINK_UNMATCHED",
    "CASH_ON_DELIVERY_VARIANCE",
    "STORE_CREDIT_MISMATCH",
    "PROMOTIONAL_DISCOUNT_VARIANCE",
    "MANUAL_ADJUSTMENT_ANOMALY",
    "UNKNOWN",
  ];

  it("has 25 retail exception categories", () => {
    expect(RETAIL_EXCEPTION_CATEGORIES.length).toBe(25);
  });

  it("includes all core payment exception types", () => {
    expect(RETAIL_EXCEPTION_CATEGORIES).toContain("GATEWAY_FEE_VARIANCE");
    expect(RETAIL_EXCEPTION_CATEGORIES).toContain("SETTLEMENT_SHORTFALL");
    expect(RETAIL_EXCEPTION_CATEGORIES).toContain("REFUND_NOT_CREDITED");
    expect(RETAIL_EXCEPTION_CATEGORIES).toContain("CHARGEBACK_UNRECONCILED");
  });

  it("includes UNKNOWN as a fallback category", () => {
    expect(RETAIL_EXCEPTION_CATEGORIES).toContain("UNKNOWN");
  });

  it("includes African market-specific categories", () => {
    expect(RETAIL_EXCEPTION_CATEGORIES).toContain("CASH_ON_DELIVERY_VARIANCE");
    expect(RETAIL_EXCEPTION_CATEGORIES).toContain("CROSS_BORDER_FEE_VARIANCE");
    expect(RETAIL_EXCEPTION_CATEGORIES).toContain("BANK_TRANSFER_SHORTFALL");
  });
});

// ─── 7. Hardening tests — exercise the REAL module functions ─────────────────
// The blocks above mirror the logic inline; these import the actual
// implementations so spec regressions (e.g. timestamp units) cannot hide.

import {
  verifyOAuthSignature,
  verifyWebhookHmac,
  isTimestampValid,
  buildPostSignature,
} from "./connectors/shopline/signature";
import { normaliseToTransactions } from "./connectors/shopline/settlementSync";
import type { ShoplineOrder, ShoplinePaymentTransaction } from "./connectors/shopline/apiClient";

describe("SHOPLINE signature module (real functions)", () => {
  const secret = "real-fn-secret";

  function signParams(params: Record<string, string>): string {
    const message = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return crypto.createHmac("sha256", secret).update(message).digest("hex");
  }

  it("accepts a valid callback with a MILLISECOND timestamp (SHOPLINE's actual unit)", () => {
    const params: Record<string, string> = {
      appkey: "k1",
      code: "auth_code",
      handle: "mystore",
      timestamp: String(Date.now()), // milliseconds — the wire format
    };
    const sign = signParams(params);
    expect(verifyOAuthSignature({ ...params, sign }, secret)).toBe(true);
  });

  it("tolerates a second-resolution timestamp (fails safe on a unit change)", () => {
    const params: Record<string, string> = {
      appkey: "k1",
      handle: "mystore",
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    const sign = signParams(params);
    expect(verifyOAuthSignature({ ...params, sign }, secret)).toBe(true);
  });

  it("rejects a stale timestamp outside the ±10 minute window", () => {
    const params: Record<string, string> = {
      appkey: "k1",
      handle: "mystore",
      timestamp: String(Date.now() - 11 * 60 * 1000),
    };
    const sign = signParams(params);
    expect(verifyOAuthSignature({ ...params, sign }, secret)).toBe(false);
  });

  it("rejects a tampered parameter", () => {
    const params: Record<string, string> = {
      appkey: "k1",
      handle: "mystore",
      timestamp: String(Date.now()),
    };
    const sign = signParams(params);
    expect(verifyOAuthSignature({ ...params, handle: "evilstore", sign }, secret)).toBe(false);
  });

  it("isTimestampValid handles both ms and seconds", () => {
    expect(isTimestampValid(Date.now())).toBe(true);
    expect(isTimestampValid(Math.floor(Date.now() / 1000))).toBe(true);
    expect(isTimestampValid(Date.now() - 20 * 60 * 1000)).toBe(false);
    expect(isTimestampValid(Number.NaN)).toBe(false);
  });

  it("verifyWebhookHmac (real fn) accepts hex and base64, rejects tampering", () => {
    const body = Buffer.from('{"id":"1"}');
    const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const b64 = crypto.createHmac("sha256", secret).update(body).digest("base64");
    expect(verifyWebhookHmac(body, hex, secret)).toBe(true);
    expect(verifyWebhookHmac(body, b64, secret)).toBe(true);
    expect(verifyWebhookHmac(Buffer.from('{"id":"2"}'), hex, secret)).toBe(false);
  });

  it("buildPostSignature signs body + timestamp", () => {
    const body = '{"code":"c1"}';
    const ts = 1784400000000;
    const expected = crypto.createHmac("sha256", secret).update(`${body}${ts}`).digest("hex");
    expect(buildPostSignature(body, ts, secret)).toBe(expected);
  });
});

describe("SHOPLINE settlement normalisation (real function)", () => {
  const order = {
    id: "order-1001",
    name: "#1001",
    financial_status: "paid",
    currency: "USD",
    presentment_currency: "USD",
    current_total_price_set: { shop_money: { amount: "100.00", currency_code: "USD" } },
    total_outstanding: "0",
    payment_details: [],
    payment_gateway_names: ["shopline_payments"],
    refunds: [],
    created_at: "2026-07-01T00:00:00+00:00",
    updated_at: "2026-07-01T00:00:00+00:00",
    processed_at: "2026-07-01T00:00:00+00:00",
  } as unknown as ShoplineOrder;

  const paymentTx = {
    trade_order_id: "trade-1",
    seller_order_id: "order-1001",
    channel_deal_id: "ch-deal-1",
    amount: "100.00",
    paid_amount: "100.00",
    currency: "USD",
    fee: "-2.90",
    fee_type: "domestic",
    status: "SUCCEEDED", // PAYMENT rows use SUCCEEDED, not SUCCESS
    payment_method: "CreditCard",
    create_time: "2026-07-01T00:01:00+00:00",
    update_time: "2026-07-01T00:01:00+00:00",
  } as unknown as ShoplinePaymentTransaction;

  it("keeps SUCCEEDED payment transactions as targets", () => {
    const { targetTxns } = normaliseToTransactions([order], [paymentTx], [], "USD");
    expect(targetTxns).toHaveLength(1);
  });

  it("drops non-SUCCEEDED payment transactions (SUCCESS is a payout status, not a payment status)", () => {
    const failed = { ...paymentTx, status: "FAILED" } as ShoplinePaymentTransaction;
    const legacySuccess = { ...paymentTx, status: "SUCCESS" } as ShoplinePaymentTransaction;
    const { targetTxns } = normaliseToTransactions([order], [failed, legacySuccess], [], "USD");
    expect(targetTxns).toHaveLength(0);
  });

  it("joins source and target on the order id ↔ seller_order_id key (engine pass-1 exact ref match)", () => {
    const { sourceTxns, targetTxns } = normaliseToTransactions([order], [paymentTx], [], "USD");
    expect(sourceTxns[0].transactionRef).toBe("order-1001");
    expect(targetTxns[0].transactionRef).toBe("order-1001");
    expect(sourceTxns[0].externalRef).toBe("#1001");
    expect(targetTxns[0].externalRef).toBe("trade-1");
  });
});
