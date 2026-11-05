/**
 * SHOPLINE GDPR requests that are still open, reported to the owner before
 * SHOPLINE's 30-day deadline passes.
 *
 * A request stays open (`received`) while it is acknowledged but not met. Today
 * that is every SHOPLINE `shop/redact` for a store we hold: the store is
 * uninstalled, but nothing erases its data yet
 * (docs/security/SHOPLINE_SHOP_ERASURE.md). Recording that truthfully is not
 * enough on its own, because no page lists these rows, and a log line needs log
 * access to be seen. Shopify's privacy requests had the same gap, closed by
 * `connectors/shopify/privacyDeadlines.ts`; this is SHOPLINE's equivalent.
 *
 * The owner is emailed when a request arrives and again by every daily batch
 * while any request is open: counts and dates only, never a shop domain,
 * subject hash or other request content.
 */
import { count, eq, min, sql } from "drizzle-orm";
import { slConnectorGdprRequests } from "../../../drizzle/connector_schema";
import { notifyOwner } from "../../_core/notification";
import { getDb } from "../../db";
import { loggableError } from "../../dbErrors";
import { runBackgroundWork } from "../../maintenance/lifecycle";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const DAY_MS = 24 * 60 * 60_000;

/** SHOPLINE's limit for meeting a GDPR request, counted from receipt. */
export const SHOPLINE_GDPR_DEADLINE_DAYS = 30;

export interface OpenShoplineGdprRequests {
  requests: number;
  oldestReceivedAt: Date;
  /** Open requests already past the deadline. */
  overdue: number;
}

/** Every tenant's open requests, as one count. Null when there are none. */
export async function findOpenShoplineGdprRequests(db: Db, now: Date): Promise<OpenShoplineGdprRequests | null> {
  const receivedAt = slConnectorGdprRequests.receivedAt;
  const dueBefore = new Date(now.getTime() - SHOPLINE_GDPR_DEADLINE_DAYS * DAY_MS);
  const [row] = await db
    .select({
      requests: count(),
      oldestReceivedAt: min(receivedAt),
      // Both operands bound: the cutoff is encoded by the column, so it
      // compares in the column's UTC terms (as privacyDeadlines.ts does).
      overdue: sql<number>`SUM(CASE WHEN ${receivedAt} < ${sql.param(dueBefore, receivedAt)} THEN 1 ELSE 0 END)`.mapWith(
        Number,
      ),
    })
    .from(slConnectorGdprRequests)
    .where(eq(slConnectorGdprRequests.status, "received"));
  if (!row || Number(row.requests) === 0 || !row.oldestReceivedAt) return null;
  return { requests: Number(row.requests), oldestReceivedAt: row.oldestReceivedAt, overdue: row.overdue || 0 };
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The owner's message. Pure. */
export function describeOpenShoplineGdprRequests(
  open: OpenShoplineGdprRequests,
  now: Date,
): { title: string; content: string } {
  const due = new Date(open.oldestReceivedAt.getTime() + SHOPLINE_GDPR_DEADLINE_DAYS * DAY_MS);
  const daysLeft = Math.floor((due.getTime() - now.getTime()) / DAY_MS);
  const deadline = daysLeft < 0 ? `OVERDUE since ${day(due)}` : `due by ${day(due)} (${daysLeft} days left)`;
  return {
    title:
      open.overdue > 0
        ? `SHOPLINE GDPR requests OVERDUE: ${open.overdue} past SHOPLINE's ${SHOPLINE_GDPR_DEADLINE_DAYS}-day deadline`
        : `SHOPLINE GDPR requests need action: ${open.requests} open`,
    content: [
      `${open.requests} SHOPLINE GDPR request(s) are open: acknowledged, but not yet met.`,
      `SHOPLINE requires each to be met within ${SHOPLINE_GDPR_DEADLINE_DAYS} days of receipt.`,
      `The oldest was received ${day(open.oldestReceivedAt)}, and is ${deadline}.`,
      "",
      "A shop/redact (shop data erasure) stays open because nothing erases a SHOPLINE shop's data yet.",
      "Someone has to meet it before the deadline: see docs/security/SHOPLINE_SHOP_ERASURE.md.",
      "The requests are the rows of sl_connector_gdpr_requests whose status is 'received'.",
    ].join("\n"),
  };
}

export interface ShoplineGdprDeadlineDeps {
  db?: Db | null;
  now?: () => Date;
  notify?: typeof notifyOwner;
}

/**
 * Count the open requests, log them, and email the owner. Returns what it
 * found. Throws only if the count itself fails.
 */
export async function checkShoplineGdprDeadlines(
  deps: ShoplineGdprDeadlineDeps = {},
): Promise<{ requests: number; overdue: number; notified: boolean }> {
  const db = deps.db !== undefined ? deps.db : await getDb();
  if (!db) throw new Error("Database unavailable");
  const now = (deps.now ?? (() => new Date()))();
  const open = await findOpenShoplineGdprRequests(db, now);
  if (!open) return { requests: 0, overdue: 0, notified: false };
  console.error("[shopline-gdpr] GDPR requests are open before SHOPLINE's deadline", {
    code: open.overdue > 0 ? "shopline_gdpr_overdue" : "shopline_gdpr_open",
    requests: open.requests,
    overdue: open.overdue,
  });
  const notified = await (deps.notify ?? notifyOwner)(describeOpenShoplineGdprRequests(open, now)).catch(() => false);
  return { requests: open.requests, overdue: open.overdue, notified };
}

/**
 * Run the check as tracked background work: the caller (a webhook ack, the
 * daily batch) neither waits for the email nor fails with it, and a shutdown
 * drain waits for it. A failed count is logged under its own code.
 */
export function reportOpenShoplineGdprRequests(deps: ShoplineGdprDeadlineDeps = {}): void {
  runBackgroundWork(async () => {
    try {
      await checkShoplineGdprDeadlines(deps);
    } catch (error) {
      console.error("[shopline-gdpr] could not check open GDPR requests", {
        code: "shopline_gdpr_check_failed",
        ...loggableError(error),
      });
    }
  });
}
