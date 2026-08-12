/**
 * Which taxonomy channels apply to a transaction, decided from the CHANNEL it
 * arrived on rather than guessed from its description.
 *
 * The Super Agent injects a slice of the 121-exception Nigerian catalogue into
 * its diagnosis prompt, and until now that slice was chosen exclusively by
 * regex over `description + transactionRef + counterparty`
 * (`relevantNigerianChannelsForText`). That works on narrative text and fails
 * silently on the files banks actually send:
 *
 *     SETTLEMENT 20260812 BATCH 4471          → no match
 *     TRF/0234917/OKAFOR C                    → no match
 *     ACQ 539983****4412 20260812             → no match
 *
 * No match means no taxonomy block, so the agent diagnoses a POS acquiring
 * break with no knowledge of MSC netting, RRN/STAN semantics or T+1 settlement
 * windows — the moat quietly disengages on exactly the institutional data it
 * was built for, and nothing reports that it did.
 *
 * The platform already knows the answer with certainty: every transaction
 * carries a `channelId`, and that channel declares a `channelType`. This module
 * turns that into taxonomy keys, and `relevantNigerianChannels` unions it with
 * the text heuristic so a POS channel whose description also says "chargeback"
 * gets the dispute catalogue too.
 *
 * Deliberately NOT keyed on the channel's free-text `code`. Codes are
 * tenant-authored (`POS_INTERSWITCH`, `CARD_MASTERCARD_ISW`, `sl_orders_…`), so
 * matching them would make the agent's behaviour depend on what someone typed
 * when creating a channel. `channelType` is a database enum — a closed set the
 * schema enforces.
 */
import type { NigerianChannelKey } from "./index";
import { relevantNigerianChannelsForText, MAX_PROMPT_CHANNELS } from "./seed";

/**
 * `channels.channelType` → the taxonomy channels that describe its failures.
 *
 * Ordered most-specific first within each entry, because the result is capped
 * at MAX_PROMPT_CHANNELS and the cap must drop the least relevant block rather
 * than an arbitrary one.
 *
 * Several types map to more than one group, which is correct rather than
 * sloppy: a POS acquiring break is genuinely diagnosed against the terminal
 * catalogue, the switch catalogue (Interswitch/UP/eTranzact route it) and the
 * dispute catalogue (it becomes a chargeback if unresolved). That is how a
 * settlement analyst reasons about it.
 */
const CHANNEL_TYPE_TAXONOMY: Record<string, readonly NigerianChannelKey[]> = {
  // ── Interbank rails ──────────────────────────────────────────────────
  nibss: ["nip", "neft"],
  bank_transfer: ["nip", "neft"],
  rtgs: ["rtgs"],
  swift: ["swift"],

  // ── Card acceptance and processing ───────────────────────────────────
  pos: ["pos", "card_switching", "card_disputes"],
  atm: ["atm", "card_switching"],
  card_payments: ["card_schemes", "card_switching", "card_disputes"],

  // ── Self-service and assisted channels ───────────────────────────────
  ussd: ["mobile_channels"],
  mobile_banking: ["mobile_channels"],
  mobile_money: ["mobile_channels"],
  agent_banking: ["mobile_channels"],
  qr_payment: ["qr"],

  // ── Third-party origination ──────────────────────────────────────────
  fintech_api: ["fintech_gateway"],

  // ── The core banking ledger is the COUNTER-side of every reconciliation,
  //    not a channel with failure modes of its own. `cbs_ledger` appears in
  //    almost every exception's `sources` for that reason. Mapping it to a
  //    taxonomy slice would inject a near-arbitrary block on the one channel
  //    that is always present, so it maps to nothing and the text heuristic
  //    decides.
  bank_core: [],

  // ── Retail / e-commerce types belong to the SHOPLINE vertical and have
  //    their own taxonomy (server/exceptions/retail-commerce.ts). Injecting
  //    Nigerian interbank patterns for them would be actively misleading —
  //    a merchant answers to card schemes and gateway agreements, not the CBN.
  ecommerce_gateway: [],
  marketplace_payout: [],
  buy_now_pay_later: [],
  digital_wallet: [],
};

/** The taxonomy channels a `channels.channelType` implies. Empty when unknown. */
export function taxonomyChannelsForChannelType(
  channelType: string | null | undefined,
): NigerianChannelKey[] {
  if (!channelType) return [];
  return [...(CHANNEL_TYPE_TAXONOMY[channelType] ?? [])];
}

/**
 * The taxonomy slice for one transaction.
 *
 * Channel-derived keys come FIRST and are never displaced by text-derived ones,
 * because the channel is a fact and the text is an inference. The text keys then
 * add specificity the channel cannot express — "chargeback" in the description of
 * a `card_payments` transaction is already covered, but "remita" on a
 * `bank_transfer` correctly pulls in the TSA catalogue.
 *
 * Capped at MAX_PROMPT_CHANNELS, the same bound the text-only path has always
 * applied, so this cannot grow prompt cost without limit.
 */
export function relevantNigerianChannels(input: {
  channelType?: string | null;
  text?: string | null;
}): NigerianChannelKey[] {
  const fromChannel = taxonomyChannelsForChannelType(input.channelType);
  const fromText = input.text ? relevantNigerianChannelsForText(input.text) : [];
  return Array.from(new Set([...fromChannel, ...fromText])).slice(0, MAX_PROMPT_CHANNELS);
}
