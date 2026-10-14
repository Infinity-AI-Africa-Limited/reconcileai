import { and, eq, lt, or } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";

/**
 * Keyset paging for the control registries (evidence, policies): a page is a
 * page, it says whether more exists, and it hands back the cursor that reaches
 * the rest. OFFSET is not used because an insert ahead of the window shifts
 * every later row and silently skips one.
 */

/**
 * Rows strictly after a keyset cursor, in `<sort> DESC, id DESC` order.
 *
 * The ORDER BY must be exactly these two columns. A third sort key the cursor
 * does not carry would let two rows tie on the cursor's terms, and the page
 * boundary would then repeat or skip whichever the engine happened to order
 * differently between calls.
 */
export function afterCursor(
  sortColumn: MySqlColumn,
  idColumn: MySqlColumn,
  position: { sort: Date; id: number }
) {
  return or(
    lt(sortColumn, position.sort),
    and(eq(sortColumn, position.sort), lt(idColumn, position.id))
  );
}

/** A bounded page, and the cursor that reaches what it did not return. */
export function page<Row extends { id: number }>(
  rows: Row[],
  limit: number,
  positionOf: (row: Row) => Date
): { rows: Row[]; hasMore: boolean; nextCursor: { id: number; at: Date } | null } {
  // One row beyond the limit was fetched purely to answer "is there more?".
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const last = visible[visible.length - 1];
  return {
    rows: visible,
    hasMore,
    nextCursor: hasMore && last ? { id: last.id, at: positionOf(last) } : null,
  };
}
