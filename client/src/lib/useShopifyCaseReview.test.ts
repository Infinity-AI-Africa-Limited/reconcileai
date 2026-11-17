import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ShopifyAppBridgeContext, ShopifySettlementEvidenceCommitted } from "./shopifyAppBridge";

/** Deterministic hook lifecycle harness, no DOM/new test dependency. Controller
 * races and real JSX rendering are exercised separately in shopifyCaseReview.
 */
const harness = vi.hoisted(() => ({
  memo: null as null | { deps: unknown[]; value: unknown },
  effectIndex: 0,
  effects: [] as Array<{ deps: unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>,
  reviews: [] as Array<{ refresh: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; activate: ReturnType<typeof vi.fn>; getSnapshot: () => object; subscribe: () => () => void }>,
}));
const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
vi.mock("react", () => ({
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    if (!harness.memo || !same(harness.memo.deps, deps)) harness.memo = { value: factory(), deps };
    return harness.memo.value;
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const index = harness.effectIndex++; const previous = harness.effects[index];
    if (!previous || !same(previous.deps, deps)) harness.pending.push(() => {
      previous?.cleanup?.();
      harness.effects[index] = { deps, cleanup: effect() ?? undefined };
    });
  },
}));
vi.mock("./shopifyCaseReview", () => ({
  createShopifyCaseReview: () => {
    const review = { refresh: vi.fn(async () => {}), dispose: vi.fn(), activate: vi.fn(), refuseAuthentication: vi.fn(), getSnapshot: () => ({ list: null, detail: null }), subscribe: () => () => {} };
    harness.reviews.push(review); return review;
  },
}));
import { useShopifyCaseReview } from "@/hooks/useShopifyCaseReview";
const context = (shop: string): ShopifyAppBridgeContext => ({ store: { shopDomain: `${shop}.myshopify.com`, displayName: shop, currency: "USD" }, sync: { lastSuccessfulAt: null, lastErrorCode: null, lastErrorAt: null, latestRequest: null, pendingSince: null, requestCount: 0 }, capabilities: { scope: "read_orders", readOrders: true, manualSync: true, shopifyPayments: false, mutations: false } });
const imported: ShopifySettlementEvidenceCommitted = { committed: true, mapping: {}, totalRows: 1, imported: 1, duplicates: 0, failed: 0, matchedCount: 0, exceptionCount: 100, unalignedRows: 0 };
function HookHarness(ctx: ShopifyAppBridgeContext | null, result: ShopifySettlementEvidenceCommitted | null = null) {
  harness.effectIndex = 0;
  const hook = useShopifyCaseReview(ctx, result);
  const beforeEffects = hook.state;
  harness.pending.splice(0).forEach(effect => effect());
  return { ...hook, beforeEffects };
}
beforeEach(() => { harness.memo = null; harness.effects = []; harness.pending = []; harness.reviews = []; });
describe("when verified embedded context or imports change", () => {
  it("should create an empty controller before rendering a changed shop and dispose prior work", () => {
    const first = HookHarness(context("a")); const next = HookHarness(context("b"));
    expect(next.review).not.toBe(first.review); expect(next.beforeEffects).toMatchObject({ list: null, detail: null });
    expect(harness.reviews[0].dispose).toHaveBeenCalledTimes(1);
    expect(harness.reviews[1].refresh).toHaveBeenCalledTimes(1);
    HookHarness(null); expect(harness.reviews[1].dispose).toHaveBeenCalledTimes(1);
    expect(harness.reviews[2].refresh).not.toHaveBeenCalled();
  });
  it("should refresh after a successful import without substituting its exception counter for live totals", () => {
    const ctx = context("a"); HookHarness(ctx); const after = HookHarness(ctx, imported);
    expect(harness.reviews[0].refresh).toHaveBeenCalledTimes(2);
    expect(after.state).toMatchObject({ list: null });
    HookHarness({ ...ctx, sync: { ...ctx.sync, requestCount: 2 } }, imported);
    expect(harness.reviews).toHaveLength(1); expect(harness.reviews[0].refresh).toHaveBeenCalledTimes(2);
  });
});
