/**
 * Shopify privacy requests that need a person — or have stopped moving — before
 * Shopify's 30-day compliance deadline passes.
 *
 * Several outcomes are deliberately left to an operator: `shop/redact` is
 * report-only (SHOPIFY_SHOP_REDACTION_BLOCKER — automatic deletion is not
 * enabled), and a request whose selectors could not be protected, or whose job
 * failed terminally, parks in `manual_review` or `failed_terminal`. Nothing
 * showed those to anyone: no page lists them and nothing alerted, so a deletion
 * request could pass its deadline seen only by a database query.
 *
 * This reports them — counts and dates only, never a selector, subject or any
 * other request content — as a structured log line on every check, and to the
 * owner by email at most once a day.
 */
import { and, inArray, lt, or, sql } from "drizzle-orm";
import { shopifyPrivacyRequests } from "../../../drizzle/shopify_schema";
import { notifyOwner } from "../../_core/notification";
import { getDb } from "../../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const DAY_MS = 24 * 60 * 60_000;

/** Shopify's limit for completing a compliance request. */
export const SHOPIFY_PRIVACY_DEADLINE_DAYS = 30;
/** A request still in flight after this long has stopped moving. */
export const SHOPIFY_PRIVACY_STUCK_AFTER_MS = 3 * DAY_MS;
/** How often the requests are counted, and how often the owner is emailed. */
export const SHOPIFY_PRIVACY_DEADLINE_CHECK_MS = 60 * 60_000;
export const SHOPIFY_PRIVACY_DEADLINE_NOTIFY_MS = DAY_MS;

/** Outcomes no job will move on from: a person has to act. */
const NEEDS_A_PERSON = [
  "manual_review",
  "blocked_dependency",
  "blocked_legal_retention",
  "failed_terminal",
  "failed",
] as const;
/** Statuses a job is expected to move on from by itself. */
const IN_FLIGHT = ["received", "processing", "failed_retryable"] as const;

export interface ShopifyPrivacyAttentionGroup {
  topic: string;
  status: string;
  requests: number;
  oldestReceivedAt: Date;
  /** Requests in this group already past Shopify's deadline. */
  overdue: number;
}

export async function findShopifyPrivacyRequestsNeedingAttention(
  db: Db,
  now: Date,
): Promise<ShopifyPrivacyAttentionGroup[]> {
  const receivedAt = shopifyPrivacyRequests.receivedAt;
  const stuckBefore = new Date(now.getTime() - SHOPIFY_PRIVACY_STUCK_AFTER_MS);
  const dueBefore = new Date(now.getTime() - SHOPIFY_PRIVACY_DEADLINE_DAYS * DAY_MS);
  const rows = await db
    .select({
      topic: shopifyPrivacyRequests.topic,
      status: shopifyPrivacyRequests.status,
      requests: sql<number>`COUNT(*)`.mapWith(Number),
      oldestReceivedAt: sql<Date>`MIN(${receivedAt})`.mapWith(receivedAt),
      // Encoded by the column, so the comparison is in the column's UTC terms.
      overdue: sql<number>`SUM(CASE WHEN ${receivedAt} < ${sql.param(dueBefore, receivedAt)} THEN 1 ELSE 0 END)`.mapWith(
        Number,
      ),
    })
    .from(shopifyPrivacyRequests)
    .where(
      or(
        inArray(shopifyPrivacyRequests.status, [...NEEDS_A_PERSON]),
        and(inArray(shopifyPrivacyRequests.status, [...IN_FLIGHT]), lt(receivedAt, stuckBefore)),
      ),
    )
    .groupBy(shopifyPrivacyRequests.topic, shopifyPrivacyRequests.status);
  return rows.map((row) => ({ ...row, overdue: row.overdue || 0 }));
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The owner's message, or null when nothing needs attention. Pure. */
export function describeShopifyPrivacyAttention(
  groups: ShopifyPrivacyAttentionGroup[],
  now: Date,
): { title: string; content: string; requests: number; overdue: number } | null {
  if (groups.length === 0) return null;
  const requests = groups.reduce((sum, group) => sum + group.requests, 0);
  const overdue = groups.reduce((sum, group) => sum + group.overdue, 0);
  const lines = [...groups]
    .sort((left, right) => left.oldestReceivedAt.getTime() - right.oldestReceivedAt.getTime())
    .map((group) => {
      const due = new Date(group.oldestReceivedAt.getTime() + SHOPIFY_PRIVACY_DEADLINE_DAYS * DAY_MS);
      const daysLeft = Math.floor((due.getTime() - now.getTime()) / DAY_MS);
      const deadline = daysLeft < 0 ? `OVERDUE since ${day(due)}` : `due by ${day(due)} (${daysLeft} days left)`;
      return `- ${group.topic} · ${group.status}: ${group.requests} request(s); oldest received ${day(group.oldestReceivedAt)}, ${deadline}`;
    });
  return {
    title: overdue > 0
      ? `Shopify privacy requests OVERDUE: ${overdue} past Shopify's ${SHOPIFY_PRIVACY_DEADLINE_DAYS}-day deadline`
      : `Shopify privacy requests need action: ${requests}`,
    content: [
      `${requests} Shopify privacy request(s) need a person or have stopped moving.`,
      `Shopify requires each to be completed within ${SHOPIFY_PRIVACY_DEADLINE_DAYS} days of receipt.`,
      "",
      ...lines,
      "",
      "Shop redaction is report-only: deleting a shop's data needs an operator.",
      "Details are in the shopify_privacy_requests table and its job tables.",
    ].join("\n"),
    requests,
    overdue,
  };
}

export interface ShopifyPrivacyDeadlineDeps {
  db?: Db | null;
  now?: () => Date;
  notify?: typeof notifyOwner;
}

/**
 * Count the requests needing attention, log them, and email the owner when
 * `email` is set. Returns what it found. Throws only if the count itself fails.
 */
export async function checkShopifyPrivacyDeadlines(
  options: { email: boolean },
  deps: ShopifyPrivacyDeadlineDeps = {},
): Promise<{ requests: number; overdue: number; notified: boolean }> {
  const db = deps.db !== undefined ? deps.db : await getDb();
  if (!db) throw new Error("Database unavailable");
  const now = (deps.now ?? (() => new Date()))();
  const message = describeShopifyPrivacyAttention(await findShopifyPrivacyRequestsNeedingAttention(db, now), now);
  if (!message) return { requests: 0, overdue: 0, notified: false };
  console.error("[shopify-privacy] privacy requests need action before Shopify's deadline", {
    code: message.overdue > 0 ? "shopify_privacy_overdue" : "shopify_privacy_needs_action",
    requests: message.requests,
    overdue: message.overdue,
  });
  let notified = false;
  if (options.email) {
    notified = await (deps.notify ?? notifyOwner)({ title: message.title, content: message.content }).catch(() => false);
  }
  return { requests: message.requests, overdue: message.overdue, notified };
}

let lastCheckAt = 0;
let lastNotifiedAt = 0;

/**
 * The throttled form the privacy sweep calls every 30 seconds: counts at most
 * hourly, emails at most daily (per process; with several instances, one email
 * per instance per day). An email that could not be sent is retried at the
 * next hourly check rather than a day later.
 */
export async function runShopifyPrivacyDeadlineCheck(deps: ShopifyPrivacyDeadlineDeps = {}): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (now - lastCheckAt < SHOPIFY_PRIVACY_DEADLINE_CHECK_MS) return;
  lastCheckAt = now;
  const email = now - lastNotifiedAt >= SHOPIFY_PRIVACY_DEADLINE_NOTIFY_MS;
  const result = await checkShopifyPrivacyDeadlines({ email }, deps);
  if (result.notified) lastNotifiedAt = now;
}

/** Test-only: forget the throttle state. */
export function resetShopifyPrivacyDeadlineThrottle(): void {
  lastCheckAt = 0;
  lastNotifiedAt = 0;
}
