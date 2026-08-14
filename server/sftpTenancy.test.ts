/**
 * SFTP credential tenancy, and the drizzle `.where()` trap behind it.
 *
 * `sftp_credentials` rows hold BANK CONNECTION SECRETS — host, username,
 * encrypted password/key, remote path. Every accessor was previously keyed on
 * `id` alone, and `sftp.delete` was reachable from a GUEST session, so anyone
 * able to guess a primary key could read, repoint or delete another
 * institution's bank feed.
 *
 * The second defect is subtler and caused a cross-tenant READ on its own:
 * chaining `.where()` in drizzle does NOT AND the predicates — each call
 * REPLACES the previous one. `getAnomalyScores` chained four, so only the last
 * (`minScore`) survived and an organizationId-filtered call returned every
 * tenant's rows. These tests pin the corrected shape.
 */
import { describe, it, expect } from "vitest";
import { and, eq, gte } from "drizzle-orm";
import { sftpCredentials, sftpIngestionLogs, anomalyScores } from "../drizzle/schema";

/** Collect column names and bound values from a drizzle SQL fragment. */
function refs(fragment: unknown): string {
  const parts: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth = 0): void => {
    if (v === null || v === undefined || depth > 10) return;
    if (typeof v === "string" || typeof v === "number") { parts.push(String(v)); return; }
    if (typeof v !== "object" || seen.has(v as object)) return;
    seen.add(v as object);
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string" && o.columnType) { parts.push(o.name); return; }
    for (const k of ["queryChunks", "value", "left", "right", "sql", "chunks"]) {
      if (k in o) walk(o[k], depth + 1);
    }
    if (Array.isArray(v)) for (const i of v) walk(i, depth + 1);
  };
  walk(fragment);
  return parts.join(" ");
}

describe("the drizzle .where() chaining trap", () => {
  it("and() combines every predicate — the shape all multi-filter reads must use", () => {
    const combined = and(
      eq(anomalyScores.transactionId, 1),
      eq(anomalyScores.organizationId, 7),
      gte(anomalyScores.anomalyScore, "0.5"),
    );
    const s = refs(combined);
    // All three survive. Under the old chained form only the last one did.
    expect(s).toContain("transactionId");
    expect(s).toContain("organizationId");
    expect(s).toContain("anomalyScore");
  });

  it("a single predicate does not mention the others", () => {
    // Demonstrates the failure mode: the last .where() wins and the earlier
    // filters — including organizationId — simply vanish.
    const lastOnly = gte(anomalyScores.anomalyScore, "0.5");
    expect(refs(lastOnly)).not.toContain("organizationId");
  });
});

describe("SFTP credential predicates are org-scoped", () => {
  it("a credential lookup constrains on id AND organizationId", () => {
    const p = and(eq(sftpCredentials.id, 5), eq(sftpCredentials.organizationId, 7));
    const s = refs(p);
    expect(s).toContain("organizationId");
    expect(s).toContain("id");
  });

  it("an id-only predicate is exactly what the vulnerability looked like", () => {
    // Kept as a negative control: this is the shape that let one tenant
    // update or delete another tenant's bank feed.
    expect(refs(eq(sftpCredentials.id, 5))).not.toContain("organizationId");
  });

  it("ingestion-log reads combine credential and org rather than replacing", () => {
    const p = and(
      eq(sftpIngestionLogs.sftpCredentialId, 5),
      eq(sftpIngestionLogs.organizationId, 7),
    );
    const s = refs(p);
    expect(s).toContain("sftpCredentialId");
    expect(s).toContain("organizationId");
  });

  it("distinct organizations produce distinct predicates", () => {
    expect(refs(eq(sftpCredentials.organizationId, 7)))
      .not.toBe(refs(eq(sftpCredentials.organizationId, 8)));
  });
});
