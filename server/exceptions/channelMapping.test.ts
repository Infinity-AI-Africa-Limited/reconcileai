/**
 * The Super Agent's taxonomy slice must be decided by the channel a transaction
 * arrived on, not only by whether its description happens to name that channel.
 *
 * The regression this pins: `relevantNigerianChannelsForText` was the sole
 * selector, so realistic bank file rows — "SETTLEMENT 20260812 BATCH 4471",
 * "TRF/0234917/OKAFOR C" — matched nothing, no catalogue was injected, and the
 * agent diagnosed institutional payment breaks with none of the 121 catalogued
 * patterns in context. Nothing failed; the moat just did not engage.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { taxonomyChannelsForChannelType, relevantNigerianChannels } from "./channelMapping";
import { CHANNEL_EXCEPTION_GROUPS } from "./index";
import { MAX_PROMPT_CHANNELS } from "./seed";

describe("when a transaction's channel type is known", () => {
  it("should select the taxonomy for interbank rails", () => {
    expect(taxonomyChannelsForChannelType("nibss")).toEqual(["nip", "neft"]);
    expect(taxonomyChannelsForChannelType("rtgs")).toEqual(["rtgs"]);
    expect(taxonomyChannelsForChannelType("swift")).toEqual(["swift"]);
  });

  it("should select terminal, switch and dispute catalogues for POS", () => {
    // A POS acquiring break is diagnosed against all three: the terminal, the
    // switch that routed it, and the dispute it becomes if left unresolved.
    expect(taxonomyChannelsForChannelType("pos")).toEqual(["pos", "card_switching", "card_disputes"]);
  });

  it("should map every self-service channel to the mobile catalogue", () => {
    for (const t of ["ussd", "mobile_banking", "mobile_money", "agent_banking"]) {
      expect(taxonomyChannelsForChannelType(t), t).toEqual(["mobile_channels"]);
    }
  });

  it("should give the core banking ledger no slice of its own", () => {
    // cbs_ledger is the counter-side of nearly every exception, so it carries no
    // distinguishing failure modes. Mapping it would inject an arbitrary block
    // on the one channel that is always present.
    expect(taxonomyChannelsForChannelType("bank_core")).toEqual([]);
  });

  it("should give retail channel types no Nigerian slice", () => {
    // Retail has its own taxonomy; a merchant answers to card schemes and
    // gateway agreements, not the CBN (CLAUDE.md §2A).
    for (const t of ["ecommerce_gateway", "marketplace_payout", "buy_now_pay_later", "digital_wallet"]) {
      expect(taxonomyChannelsForChannelType(t), t).toEqual([]);
    }
  });

  it("should return nothing for an unknown or absent type rather than throwing", () => {
    expect(taxonomyChannelsForChannelType(null)).toEqual([]);
    expect(taxonomyChannelsForChannelType(undefined)).toEqual([]);
    expect(taxonomyChannelsForChannelType("not_a_channel_type")).toEqual([]);
  });

  it("should only ever name channels the registry actually has", () => {
    // A typo here would inject nothing and fail silently, which is the exact
    // failure mode this module exists to end.
    const known = new Set(Object.keys(CHANNEL_EXCEPTION_GROUPS));
    const SOURCE = fs.readFileSync(path.join(__dirname, "channelMapping.ts"), "utf8");
    const types = [...SOURCE.matchAll(/^ {2}(\w+): \[/gm)].map((m) => m[1]);
    expect(types.length).toBeGreaterThan(10);
    for (const t of types) {
      for (const key of taxonomyChannelsForChannelType(t)) {
        expect(known.has(key), `${t} → ${key}`).toBe(true);
      }
    }
  });
});

describe("when the agent picks a taxonomy slice for a transaction", () => {
  it("should engage on a settlement row whose text names no channel", () => {
    // The whole point. Text alone returns nothing here.
    const text = "SETTLEMENT 20260812 BATCH 4471";
    expect(relevantNigerianChannels({ text })).toEqual([]);
    expect(relevantNigerianChannels({ channelType: "pos", text })).toContain("pos");
  });

  it("should let the text add specificity the channel cannot express", () => {
    // "remita" on a plain bank transfer legitimately pulls in the TSA catalogue.
    const picked = relevantNigerianChannels({
      channelType: "bank_transfer",
      text: "REMITA RRR 280048112947 treasury single account sweep",
    });
    expect(picked).toContain("nip");
    expect(picked).toContain("tsa");
  });

  it("should keep the channel's own catalogue ahead of text-inferred ones", () => {
    // The channel is a fact; the text is an inference. Under the cap, the fact
    // must not be the thing that gets dropped.
    const picked = relevantNigerianChannels({
      channelType: "pos",
      text: "chargeback representment arbitration nip neft rtgs swift remita ussd qr",
    });
    expect(picked.slice(0, 3)).toEqual(["pos", "card_switching", "card_disputes"]);
  });

  it("should stay within the prompt-channel cap", () => {
    const picked = relevantNigerianChannels({
      channelType: "card_payments",
      text: "nip neft rtgs swift remita ussd qr paystack salary biller mt103 chargeback",
    });
    expect(picked.length).toBeLessThanOrEqual(MAX_PROMPT_CHANNELS);
  });

  it("should stay silent when neither the channel nor the text says anything", () => {
    // An FMCG trade deduction must not pay tokens for the card catalogue.
    expect(
      relevantNigerianChannels({
        channelType: "bank_core",
        text: "INV-2847 less damage deduction per distributor agreement",
      }),
    ).toEqual([]);
  });
});

describe("the engine actually consults the channel", () => {
  // A mapping module nothing calls is decoration — the same reason
  // routeAccess.test.ts asserts App.tsx wires SegmentGuard.
  const ENGINE = fs.readFileSync(path.join(__dirname, "..", "superAgentEngine.ts"), "utf8");

  it("should pass the transaction's channelType into the selector", () => {
    expect(ENGINE).toMatch(/relevantNigerianChannels\(\{\s*channelType: txn\.channelType/);
  });

  it("should no longer select on text alone", () => {
    expect(ENGINE).not.toMatch(/relevantNigerianChannelsForText\(/);
  });

  it("should carry channelType on the transaction type", () => {
    expect(ENGINE).toMatch(/channelType\?: string \| null;/);
  });

  it("should be populated by the procedure that runs a diagnosis", () => {
    const ROUTERS = fs.readFileSync(path.join(__dirname, "..", "routers.ts"), "utf8");
    expect(ROUTERS).toMatch(/channelType: txnChannel\?\.channelType \?\? null,/);
  });
});
