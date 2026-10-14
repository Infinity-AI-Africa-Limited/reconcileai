/**
 * The outbound webhook events the platform sends, in one place.
 *
 * Shared on purpose: the Integrations page offers exactly these, and
 * `webhooks.create` accepts exactly these (plus the "*" wildcard). Before this
 * list existed the server took any string, so a mistyped event name stored a
 * subscription that could never fire, and the page offered six of the eight.
 */
export const WEBHOOK_EVENTS = [
  "upload.completed",
  "reconciliation.completed",
  "reconciliation.failed",
  "exception.created",
  "exception.resolved",
  "exception.escalated",
  "exception.in_review",
  "kpi.threshold.breached",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Subscribes a webhook to every event, present and future. */
export const ALL_WEBHOOK_EVENTS = "*";

export type WebhookSubscription = WebhookEvent | typeof ALL_WEBHOOK_EVENTS;

export const WEBHOOK_SUBSCRIPTIONS: readonly WebhookSubscription[] = [...WEBHOOK_EVENTS, ALL_WEBHOOK_EVENTS];
