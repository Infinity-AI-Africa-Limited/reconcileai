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
 * Only clearly-local hosts are allowed. Everything else is refused, and there is
 * no override — not for production, and not for a staging box either.
 *
 * The override existed briefly and was removed, because it could not be made
 * safe. It was gated on a host NOT being in the production list, and a list of
 * hostnames is a denylist: `prod.example.com.` with its DNS root dot, the same
 * cluster's IP, or a CNAME in front of it all miss the entry and would have been
 * waved through as ordinary remote hosts. Allow-listing what is local is the
 * only direction that fails closed, so the allow-list is all there is.
 *
 * Nothing legitimate is lost. `db:migrate` applies committed migrations, and
 * `drizzle-kit generate` authors one locally; generate-and-apply against a
 * shared database is the operation with no honest use.
 *
 * CI is unaffected — it runs against `127.0.0.1` — and so is the Railway deploy,
 * which runs `db:migrate` (no generate) rather than `db:push`.
 */

/**
 * Hosts that name the machine the developer is sitting at, and cannot name
 * anything else.
 *
 * Every entry is a loopback address or a reserved alias for the local host. That
 * property is the whole allow-list — a name only qualifies if the network cannot
 * redefine it.
 *
 * `mysql` and `db` were here as docker-compose service names and have been
 * removed. A bare single-label host resolves to whatever DNS, `/etc/hosts` or a
 * container network says it does, so allow-listing one lets any shared database
 * be spelled as local. Nothing is lost: the sole caller of `db:push` is CI, on
 * `127.0.0.1`. The on-prem stack does use `@db:3306`, but it runs `db:migrate`
 * (`drizzle-kit migrate`, no generate), which never passes through this guard.
 */
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "host.docker.internal", // reserved by Docker for the host machine
]);

/**
 * Hosts known to be the live product.
 *
 * This is a LABEL, not a control — it decides which refusal a developer reads,
 * not whether they are refused. Every non-local host is refused either way, so
 * an alias missing from this set costs a clearer message and nothing more.
 * Extendable with PRODUCTION_DB_HOSTS for another deployment of this codebase;
 * a hostname is not a secret (the password in the URL is).
 */
export function productionHosts(extra?: string | null): Set<string> {
  const configured = (extra ?? "").split(",").map(normaliseHost).filter(Boolean);
  return new Set(["gateway02.us-east-1.prod.aws.tidbcloud.com", ...configured]);
}

/**
 * Fold a hostname to one spelling before ANY comparison.
 *
 * A trailing dot is the DNS root form of the same name — `example.com.` and
 * `example.com` reach the same machine, but they are different strings, and that
 * was enough to walk past an exact match. Case folds for the same reason.
 */
function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

export type DbTargetVerdict =
  | { local: true; host: string }
  | { local: false; host: string; reason: "production" | "remote_host" }
  | { local: false; host: null; reason: "unset" | "unparseable" };

export function classifyDatabaseTarget(
  url: string | undefined | null,
  extraProductionHosts?: string | null,
): DbTargetVerdict {
  if (!url || !url.trim()) return { local: false, host: null, reason: "unset" };
  let host: string;
  try {
    host = new URL(url.trim()).hostname;
  } catch {
    return { local: false, host: null, reason: "unparseable" };
  }
  if (!host) return { local: false, host: null, reason: "unparseable" };
  const lower = normaliseHost(host);
  if (LOCAL_HOSTS.has(lower)) return { local: true, host };
  // Production is still labelled separately, but only so the refusal can say
  // which mistake was made. Nothing hangs on the distinction any more: both
  // reasons refuse, unconditionally. It used to gate an override, and that was
  // the bug — an alias of production (a trailing dot, an IP, a CNAME) is not in
  // this set, would have been labelled an ordinary remote host, and would have
  // been overridable. A denylist cannot be the thing a control depends on.
  if (productionHosts(extraProductionHosts).has(lower)) {
    return { local: false, host, reason: "production" };
  }
  return { local: false, host, reason: "remote_host" };
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
): string {
  const isProduction = verdict.reason === "production";
  const lines = [
    isProduction
      ? "Refusing to run `db:push` against PRODUCTION. This cannot be overridden."
      : "Refusing to run `db:push` against a database that is not local.",
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
  );
  if (isProduction) {
    // No escape hatch is offered, and none exists. There is no task that needs
    // generate-and-apply against the live product: db:migrate applies what is
    // committed and reviewed, drizzle-kit generate authors locally. Offering an
    // override here would preserve the exact operation that broke 0084, 0085
    // and 0090 — a guard with a documented way around it is a speed bump.
    lines.push(
      "",
      "There is deliberately no override for production. Migrations reach it only",
      "through the Railway pre-deploy step, which runs db:migrate on merged commits.",
    );
  } else {
    lines.push(
      "",
      "There is no override for any host. An earlier revision offered one for",
      "non-production targets, which quietly reopened the same hole: an alias of",
      "production — a trailing dot, an IP, a CNAME — is not in the production list,",
      "so it would have been treated as an ordinary remote host and let through.",
      "Point DATABASE_URL at a local database instead.",
    );
  }
  return lines.join("\n");
}
