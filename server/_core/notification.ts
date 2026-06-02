import { TRPCError } from "@trpc/server";
import { ENV } from "./env";
import { sendEmail, renderBrandedHtml, markdownToBasicHtml } from "./email";

export type NotificationPayload = {
  title: string;
  content: string;
};

const TITLE_MAX_LENGTH = 1200;
const CONTENT_MAX_LENGTH = 20000;

const trimValue = (value: string): string => value.trim();
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const buildEndpointUrl = (baseUrl: string): string => {
  const normalizedBase = baseUrl.endsWith("/")
    ? baseUrl
    : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};

const validatePayload = (input: NotificationPayload): NotificationPayload => {
  if (!isNonEmptyString(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required.",
    });
  }
  if (!isNonEmptyString(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required.",
    });
  }

  const title = trimValue(input.title);
  const content = trimValue(input.content);

  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`,
    });
  }

  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`,
    });
  }

  return { title, content };
};

/**
 * Dispatches a platform-owner notification.
 *
 * Preferred path (production): a real email via Resend to OWNER_EMAIL (falling
 * back to EMAIL_FROM). Legacy path (Manus prototype): the Manus Notification
 * Service. If neither is configured it warns and returns `false` — it never
 * throws on a missing transport, so cron jobs and digests degrade gracefully.
 * Validation errors (empty title/content) still bubble up as TRPC errors.
 *
 * Returns `true` when the notification was accepted/sent.
 */
export async function notifyOwner(
  payload: NotificationPayload
): Promise<boolean> {
  const { title, content } = validatePayload(payload);

  // Preferred: real email via Resend.
  if (ENV.resendApiKey.trim().length > 0 && ENV.emailFrom.trim().length > 0) {
    const to = ENV.ownerEmail.trim() || ENV.emailFrom.trim();
    const html = renderBrandedHtml(title, markdownToBasicHtml(content));
    const result = await sendEmail({ to, subject: title, html, text: content });
    return result.success;
  }

  // Legacy: Manus Forge notification service (prototype only).
  if (ENV.forgeApiUrl && ENV.forgeApiKey) {
    const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${ENV.forgeApiKey}`,
          "content-type": "application/json",
          "connect-protocol-version": "1",
        },
        body: JSON.stringify({ title, content }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.warn(
          `[Notification] Failed to notify owner (${response.status} ${response.statusText})${
            detail ? `: ${detail}` : ""
          }`
        );
        return false;
      }

      return true;
    } catch (error) {
      console.warn("[Notification] Error calling notification service:", error);
      return false;
    }
  }

  console.warn(
    "[Notification] No delivery channel configured — set RESEND_API_KEY + EMAIL_FROM " +
      "(recommended) or BUILT_IN_FORGE_API_* (legacy). Skipping owner notification."
  );
  return false;
}
