/**
 * What an intact audit chain must still SAY about itself.
 *
 * Two kinds of historical entry verify under a narrow, stated allowance rather
 * than exactly as written (server/auditChain.ts):
 *
 *   - rounded: signed by the earliest writer, which hashed the second and let
 *     the database round it — they verify at the second they were signed;
 *   - forked: written by two writers at the same moment, before appends were
 *     serialised — same sequence number, same parent, the chain continuing from
 *     one of them.
 *
 * Neither is hidden inside "verified". The counts go on the persistent badge,
 * not only in a toast an examiner might miss, and the tooltip says what each
 * allowance means and what it does not excuse.
 */
export interface IntegrityCounts {
  signedRows: number;
  roundedRows: number;
  forkedRows: number;
}

/** Badge text for an intact chain, with every allowance counted. */
export function intactBadge(c: IntegrityCounts): string {
  const notes: string[] = [];
  if (c.roundedRows > 0) notes.push(`${c.roundedRows.toLocaleString()} rounded`);
  if (c.forkedRows > 0) notes.push(`${c.forkedRows.toLocaleString()} concurrent`);
  return `Chain intact (${[c.signedRows.toLocaleString(), ...notes].join(" · ")})`;
}

/** Tooltip explaining each allowance in use, or undefined when none is. */
export function intactTooltip(c: IntegrityCounts): string | undefined {
  const parts: string[] = [];
  if (c.roundedRows > 0) {
    parts.push(
      `${c.roundedRows.toLocaleString()} entries were signed by the earliest audit writer, which hashed the second and let the database round it; they verify at the second they were signed.`,
    );
  }
  if (c.forkedRows > 0) {
    parts.push(
      `${c.forkedRows.toLocaleString()} entries were written at the same moment as another, before audit writes were serialised: they share a sequence number and a parent, and the chain continues from one of them.`,
    );
  }
  if (parts.length === 0) return undefined;
  return `${parts.join(" ")} Any other change to these entries is still detected.`;
}

/** The same caveats for the verification toast. */
export function intactToastSuffix(c: IntegrityCounts): string {
  const notes: string[] = [];
  if (c.roundedRows > 0) notes.push(`${c.roundedRows.toLocaleString()} at the second they were signed, stored rounded up`);
  if (c.forkedRows > 0) notes.push(`${c.forkedRows.toLocaleString()} written concurrently before writes were serialised`);
  return notes.length ? ` (${notes.join("; ")})` : "";
}
