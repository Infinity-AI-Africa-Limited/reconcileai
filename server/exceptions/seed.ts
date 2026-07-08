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
import { ALL_NIGERIAN_EXCEPTIONS } from "./index";
import type { NigerianChannelException } from "./types";

/**
 * AI prompt block for the Super Agent when diagnosing Nigerian payment
 * channel exceptions — the taxonomy is the intelligence moat.
 */
export function nigerianExceptionsTaxonomyPromptBlock(): string {
  return ALL_NIGERIAN_EXCEPTIONS.map(
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
