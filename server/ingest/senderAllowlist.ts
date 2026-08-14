/**
 * Sender allow-list for email-forward ingestion.
 *
 * The forwarding address is unguessable, but addresses leak — they end up in
 * mail rules, shared inboxes, support tickets and screenshots. So knowing the
 * address is deliberately NOT sufficient: the sender must match too. Two
 * independent controls mean one disclosure is not a breach.
 *
 * FAIL CLOSED. An empty or unparseable allow-list accepts NOTHING. The opposite
 * default — "no list configured, so allow everything" — turns a half-finished
 * setup into an open inbox that accepts financial records from any stranger,
 * and it would look like it was working.
 */

/** One entry: a full address, or `@domain` matching any address at that domain. */
export interface AllowRule {
  kind: "address" | "domain";
  value: string;
}

/** Split a stored allow-list (newline/comma/semicolon separated) into rules. */
export function parseAllowlist(raw: string | null | undefined): AllowRule[] {
  if (!raw) return [];
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      // "@stripe.com" or a bare "stripe.com" both mean the whole domain.
      if (entry.startsWith("@")) return { kind: "domain" as const, value: entry.slice(1) };
      if (!entry.includes("@")) return { kind: "domain" as const, value: entry };
      return { kind: "address" as const, value: entry };
    })
    .filter((r) => r.value.length > 0);
}

/**
 * Extract the bare address from a From header.
 * Handles `Name <a@b.com>`, `<a@b.com>` and `a@b.com`.
 */
export function normaliseSender(from: string | null | undefined): string | null {
  if (!from) return null;
  const angled = from.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : from).trim().toLowerCase();
  // Deliberately strict: exactly one @, and something either side of it.
  if (!/^[^\s@]+@[^\s@]+$/.test(candidate)) return null;
  return candidate;
}

/**
 * Is this sender permitted?
 *
 * Domain matching is an exact match on the domain part — NOT a suffix test.
 * `endsWith("stripe.com")` would also accept `evil-stripe.com`, which is the
 * classic way this check gets written and the classic way it gets bypassed.
 */
export function isSenderAllowed(from: string | null | undefined, allowlistRaw: string | null | undefined): boolean {
  const sender = normaliseSender(from);
  if (!sender) return false;

  const rules = parseAllowlist(allowlistRaw);
  if (rules.length === 0) return false; // fail closed

  const senderDomain = sender.slice(sender.lastIndexOf("@") + 1);
  for (const rule of rules) {
    if (rule.kind === "address" && rule.value === sender) return true;
    if (rule.kind === "domain" && rule.value === senderDomain) return true;
  }
  return false;
}

/** A domain label sequence: `stripe.com`, `pay.stripe.co.uk`. Requires a dot. */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** Deliberately as strict as normaliseSender: exactly one @, and a dotted domain. */
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate an allow-list before it is stored.
 *
 * Written against `parseAllowlist` rather than beside it, so what the UI accepts
 * and what the inbound path enforces can never drift apart. That drift is the
 * dangerous outcome here: an entry the enforcer will never match produces a
 * source that looks configured, reports itself healthy and rejects every
 * delivery — the same silent-nothing failure the bucket "test connection"
 * button exists to prevent.
 *
 * Empty is invalid, not permissive. The enforcer fails closed on an empty list,
 * so accepting one at configuration time would only defer the surprise.
 */
export function validateAllowlist(
  raw: string | null | undefined,
): { ok: true; rules: AllowRule[] } | { ok: false; invalid: string[] } {
  const rules = parseAllowlist(raw);
  if (rules.length === 0) return { ok: false, invalid: [] };

  const invalid = rules
    .filter((r) => !(r.kind === "domain" ? DOMAIN_RE : ADDRESS_RE).test(r.value))
    .map((r) => (r.kind === "domain" ? `@${r.value}` : r.value));

  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, rules };
}

/** Attachment types we will even consider. Everything else is refused unread. */
const ALLOWED_EXTENSIONS = /\.(csv|tsv|txt|xlsx|xlsm|xls)$/i;

/**
 * Should this attachment be fetched at all?
 *
 * Checked on the FILENAME from the webhook metadata, before any download —
 * so a malicious or oversized payload costs us nothing. We never execute or
 * interpret an attachment; accepted files go straight to the same tabular
 * parser used by manual upload.
 */
export function isIngestibleAttachment(filename: string | null | undefined): boolean {
  if (!filename) return false;
  const name = filename.trim();
  if (!name || name.length > 500) return false;
  // Path separators and traversal have no business in an attachment name.
  if (/[\\/]/.test(name) || name.includes("..")) return false;
  return ALLOWED_EXTENSIONS.test(name);
}
