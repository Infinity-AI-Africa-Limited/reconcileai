/**
 * Is this DATABASE_URL a throwaway database, or something real?
 *
 * `pnpm db:push` is `drizzle-kit generate && drizzle-kit migrate`. The generate
 * half writes a NEW migration from whatever `schema.ts` the working tree holds,
 * and the migrate half applies it — so running it against a shared database
 * publishes an unreviewed branch's schema there.
 *
 * That is not hypothetical. The local `.env` in this repo points at
 * `gateway02.us-east-1.prod.aws.tidbcloud.com`, and migrations 0084, 0085 and
 * 0090 reached production before their pull requests merged. The subsequent
 * deploys then died on their own objects (`ER_TABLE_EXISTS` / `ER_DUP_KEYNAME`)
 * because `__drizzle_migrations` had no row for them — three broken deploys, and
 * three migrations amended afterwards to guard around the damage (CLAUDE.md §12).
 *
 * §12 has warned about this in prose for months and it kept happening, because a
 * warning is not a control. This is the control.
 *
 * ── Fails closed ──────────────────────────────────────────────────────────
 *
 * Only clearly-local hosts are allowed. Anything else is refused, including
 * hosts nobody has thought about yet: a new staging box or a colleague's tunnel
 * should have to be named deliberately rather than inherit permission from a
 * pattern. The failure mode of the opposite default is a shared database with an
 * unreviewed schema on it, which is exactly what this exists to stop.
 *
 * CI is unaffected — it runs against `127.0.0.1` — and so is the Railway deploy,
 * which runs `db:migrate` (no generate) rather than `db:push`.
 */

/** Hosts that can only be a throwaway database on the developer's own machine. */
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "host.docker.internal",
  "mysql", // docker-compose service name
  "db", // docker-compose service name
]);

export type DbTargetVerdict =
  | { local: true; host: string }
  | { local: false; host: string; reason: "remote_host" }
  | { local: false; host: null; reason: "unset" | "unparseable" };

export function classifyDatabaseTarget(url: string | undefined | null): DbTargetVerdict {
  if (!url || !url.trim()) return { local: false, host: null, reason: "unset" };
  let host: string;
  try {
    host = new URL(url.trim()).hostname;
  } catch {
    return { local: false, host: null, reason: "unparseable" };
  }
  if (!host) return { local: false, host: null, reason: "unparseable" };
  return LOCAL_HOSTS.has(host.toLowerCase())
    ? { local: true, host }
    : { local: false, host, reason: "remote_host" };
}

/**
 * The refusal a developer sees. Names the host — that is not a secret, and it is
 * the one fact that makes the mistake obvious — but never the URL, which carries
 * the password.
 */
export function describeDbTargetRefusal(
  // Only a refusal can be described. Taking the whole union would mean inventing
  // a branch for "explain why the allowed thing was refused", which is not a
  // state that exists.
  verdict: Extract<DbTargetVerdict, { local: false }>,
  override: string,
): string {
  const lines = [
    "Refusing to run `db:push` against a database that is not local.",
    "",
    "`db:push` is `drizzle-kit generate && drizzle-kit migrate`: it writes a NEW",
    "migration from your working tree's schema.ts and applies it immediately. Against",
    "a shared database that publishes an unreviewed branch's schema, and the next",
    "deploy then dies on objects the migration journal has no row for.",
    "",
  ];
  if (verdict.host) lines.push(`  DATABASE_URL host: ${verdict.host}`);
  else if (verdict.reason === "unset") lines.push("  DATABASE_URL is not set.");
  else lines.push("  DATABASE_URL could not be parsed as a URL.");
  lines.push(
    "",
    "What you probably want instead:",
    "  • to APPLY committed migrations      → pnpm db:migrate",
    "  • to WRITE a migration from schema.ts → npx drizzle-kit generate (then commit it)",
    "",
    `If you genuinely mean to do this, set ${override}=1 for the single command.`,
  );
  return lines.join("\n");
}
