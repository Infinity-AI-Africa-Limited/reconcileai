/**
 * The scripted-db kit's own contract.
 *
 * Several privacy tests assert that no raw identifier was persisted by scanning
 * the committed operations as JSON. That scan is only worth anything if it can
 * actually see every place an identifier could have been written — including an
 * upsert's set-clause, which holds drizzle `SQL` values rather than plain data.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { shopifyPrivacyRequestSelectors } from "../../../drizzle/shopify_schema";
import { scriptedDb } from "./scriptedDb.testkit";

interface UpsertHandle {
  insert(table: unknown): {
    values(values: Record<string, unknown>): {
      onDuplicateKeyUpdate(config: { set: Record<string, unknown> }): Promise<unknown>;
    };
  };
}

describe("when a persistence scan reads the committed operations as JSON", () => {
  it("should surface an identifier carried in an upsert's set-clause", async () => {
    const fake = scriptedDb();
    await (fake.db as UpsertHandle)
      .insert(shopifyPrivacyRequestSelectors)
      .values({ requestId: 901 })
      .onDuplicateKeyUpdate({ set: { requestId: sql`COALESCE(${901}, ${501})` } });

    // Rendered to SQL text and parameters: 501 is reachable, not hidden behind
    // the circular table reference that made plain JSON.stringify throw.
    expect(fake.committedJson()).toContain("501");
  });

  it("should not throw on the table reference an upsert's SQL value closes over", () => {
    const fake = scriptedDb();
    expect(() => fake.committedJson()).not.toThrow();
  });
});
