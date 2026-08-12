/**
 * Seed Nigerian payment channel exception taxonomy as resolution templates.
 *
 * Mirrors the pattern in server/connectors/lapo/exceptions.ts:seedLapoResolutionTemplates
 * but covers ALL Nigerian payment channels. Can be called:
 * - At org provisioning (org-scoped templates)
 * - As global defaults (organizationId = null)
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { resolutionTemplates, type ResolutionTemplateCategory } from "../../drizzle/schema";
import { getDb } from "../db";
import { ALL_NIGERIAN_EXCEPTIONS, CHANNEL_EXCEPTION_GROUPS, type NigerianChannelKey } from "./index";
import type { NigerianChannelException } from "./types";

/**
 * Keyword patterns that map free transaction text (description, reference,
 * counterparty) to taxonomy channels. Used to inject only the RELEVANT slice
 * of the taxonomy into the Super Agent prompt — an FMCG trade deduction should
 * not pay tokens for the card-dispute catalogue, and vice versa.
 */
const CHANNEL_TEXT_PATTERNS: Array<{ channel: NigerianChannelKey; pattern: RegExp }> = [
  { channel: "nip", pattern: /\bnip\b|instant payment|name enquiry|session[ _-]?id/i },
  { channel: "neft", pattern: /\bneft\b/i },
  { channel: "rtgs", pattern: /\brtgs\b|gross settlement/i },
  { channel: "pos", pattern: /\bpos\b|terminal|merchant service charge|\bmsc\b/i },
  { channel: "atm", pattern: /\batm\b|dispense|cash withdrawal/i },
  { channel: "qr", pattern: /\bnqr\b|qr code|qr payment/i },
  { channel: "direct_debit", pattern: /direct debit|standing order|mandate/i },
  { channel: "swift", pattern: /\bswift\b|mt103|mt202|correspondent|nostro/i },
  { channel: "remittance", pattern: /remittance|\bimto\b|western union|moneygram/i },
  { channel: "fintech_gateway", pattern: /paystack|flutterwave|monnify|opay|palmpay|moniepoint|payment gateway/i },
  { channel: "bills", pattern: /bill payment|ebills|biller|electricity token/i },
  { channel: "bulk_payment", pattern: /bulk payment|salary|payroll/i },
  { channel: "tsa", pattern: /\btsa\b|treasury single|etreasury|remita/i },
  { channel: "mobile_channels", pattern: /ussd|\*\d{3}#|mobile app|agent banking|mobile banking/i },
  { channel: "card_switching", pattern: /interswitch|etranzact|unified payments?|\brrn\b|\bstan\b|force.?post|\bcard\b/i },
  { channel: "card_schemes", pattern: /verve|afrigo|\bvisa\b|mastercard|interchange|scheme fee|\bvss\b|\bcard\b/i },
  { channel: "card_disputes", pattern: /charge.?back|representment|re.?presentment|arbitration|pre.?arb|\bdispute\b|\bcard\b/i },
];

/** Max channels injected per prompt — bounds token cost on keyword-dense text. */
export const MAX_PROMPT_CHANNELS = 4;

/**
 * Infer which taxonomy channels are relevant to a piece of transaction text.
 * Returns [] when nothing matches (caller should then omit the block entirely).
 */
export function relevantNigerianChannelsForText(text: string): NigerianChannelKey[] {
  if (!text || !text.trim()) return [];
  const matched = CHANNEL_TEXT_PATTERNS.filter((p) => p.pattern.test(text)).map((p) => p.channel);
  return Array.from(new Set(matched)).slice(0, MAX_PROMPT_CHANNELS);
}

/**
 * AI prompt block for the Super Agent when diagnosing Nigerian payment
 * channel exceptions — the taxonomy is the intelligence moat.
 *
 * Pass `channels` (from relevantNigerianChannelsForText) to inject only the
 * relevant slice; with no argument the full 121-exception catalogue is returned.
 */
export function nigerianExceptionsTaxonomyPromptBlock(channels?: NigerianChannelKey[]): string {
  const pool: NigerianChannelException[] =
    channels && channels.length > 0
      ? channels.flatMap((c) => CHANNEL_EXCEPTION_GROUPS[c] ?? [])
      : ALL_NIGERIAN_EXCEPTIONS;
  return pool.map(
    (c) =>
      `- ${c.key} (${c.severity}, SLA ${c.slaHours}h): ${c.label}. ${c.aiDiagnosisHint}`,
  ).join("\n");
}

/**
 * Lookup a specific exception by key.
 */
export function nigerianExceptionFor(key: string): NigerianChannelException | null {
  return ALL_NIGERIAN_EXCEPTIONS.find((c) => c.key === key) ?? null;
}

/**
 * Seed the Nigerian payment channel taxonomy as org-scoped resolution
 * templates (idempotent). Called at org provisioning; safe to re-run.
 */
export async function seedNigerianChannelExceptionTemplates(
  organizationId: number,
): Promise<{ inserted: number; existing: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  let inserted = 0;
  let existing = 0;
  for (const cat of ALL_NIGERIAN_EXCEPTIONS) {
    const [already] = await db
      .select({ id: resolutionTemplates.id })
      .from(resolutionTemplates)
      .where(and(
        eq(resolutionTemplates.organizationId, organizationId),
        eq(resolutionTemplates.category, cat.key),
      ))
      .limit(1);
    if (already) {
      existing++;
      continue;
    }
    await db.insert(resolutionTemplates).values({
      name: cat.label,
      category: cat.key,
      templateText:
        `${cat.recommendedResolution}\n\nRegulatory context: ${cat.regulatoryContext}\n` +
        `Severity: ${cat.severity.toUpperCase()} · SLA: ${cat.slaHours}h`,
      isDefault: true,
      createdBy: 0, // system
      organizationId,
      dedupeKey: null,
    });
    inserted++;
  }
  return { inserted, existing };
}

/**
 * Seed as global defaults (organizationId = null). Uses the same
 * dedupeKey pattern as seedDefaultResolutionTemplates in seedResolutionTemplates.ts.
 * Idempotent and race-proof via ON DUPLICATE KEY.
 */
export async function seedNigerianChannelExceptionGlobalDefaults(): Promise<{ inserted: number }> {
  const db = await getDb();
  if (!db) return { inserted: 0 };

  const existing = await db
    .select({
      id: resolutionTemplates.id,
      category: resolutionTemplates.category,
      name: resolutionTemplates.name,
    })
    .from(resolutionTemplates)
    .where(and(isNull(resolutionTemplates.organizationId), eq(resolutionTemplates.isDefault, true)));

  const existingKeys = new Set(existing.map((r) => `${r.category}::${r.name}`));

  const toInsert = ALL_NIGERIAN_EXCEPTIONS.filter(
    (cat) => !existingKeys.has(`${cat.key}::${cat.label}`),
  );

  if (toInsert.length === 0) return { inserted: 0 };

  await db
    .insert(resolutionTemplates)
    .values(
      toInsert.map((cat) => ({
        name: cat.label,
        category: cat.key,
        templateText:
          `${cat.recommendedResolution}\n\nRegulatory context: ${cat.regulatoryContext}\n` +
          `Severity: ${cat.severity.toUpperCase()} · SLA: ${cat.slaHours}h`,
        isDefault: true,
        createdBy: 0,
        organizationId: null,
        dedupeKey: `default:${cat.key}:${cat.label}`,
      })),
    )
    .onDuplicateKeyUpdate({ set: { dedupeKey: sql`dedupe_key` } });

  return { inserted: toInsert.length };
}
