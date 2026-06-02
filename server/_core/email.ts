/**
 * Transactional Email — Resend
 * ─────────────────────────────────────────────────────────────────────────────
 * A single chokepoint for all outbound email (magic-link login, user invites,
 * CFO reports, threshold alerts, owner notifications).
 *
 * Provider: Resend (https://resend.com) via its REST API — no SDK dependency.
 *
 * Configuration (server/_core/env.ts → process.env):
 *   RESEND_API_KEY   required to actually send. When empty, sendEmail() is a
 *                    no-op that logs a warning and returns { success: false } —
 *                    it never throws, so dev/builds and unconfigured environments
 *                    keep working.
 *   EMAIL_FROM       sender address, e.g. noreply@reconcileai.vip
 *   EMAIL_FROM_NAME  sender display name (default "ReconcileAI")
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ENV } from "./env";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// ─── Brand palette (matches MagicLogin / Login pages) ──────────────────────────
const BRAND_NAVY = "#1B365D";
const BRAND_ORANGE = "#F47458";

export type EmailAttachment = {
  filename: string;
  /** Raw bytes; encoded to base64 for the Resend API. */
  content: Buffer | Uint8Array;
  contentType?: string;
};

export type SendEmailParams = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
};

export type SendEmailResult = {
  success: boolean;
  id?: string;
  error?: string;
  /** true when no provider key is configured (caller may treat as soft-skip). */
  skipped?: boolean;
};

function isEmailConfigured(): boolean {
  return ENV.resendApiKey.trim().length > 0 && ENV.emailFrom.trim().length > 0;
}

function buildFrom(): string {
  const name = ENV.emailFromName.trim() || "ReconcileAI";
  return `${name} <${ENV.emailFrom.trim()}>`;
}

/**
 * Send a transactional email via Resend.
 * Never throws — returns { success: false } on any failure so callers can
 * degrade gracefully (auth flows, cron jobs, etc.).
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  if (!isEmailConfigured()) {
    console.warn(
      "[Email] RESEND_API_KEY / EMAIL_FROM not configured — skipping send to " +
        `"${Array.isArray(params.to) ? params.to.join(", ") : params.to}" (subject: "${params.subject}")`
    );
    return { success: false, skipped: true, error: "email_not_configured" };
  }

  const body: Record<string, unknown> = {
    from: buildFrom(),
    to: Array.isArray(params.to) ? params.to : [params.to],
    subject: params.subject,
    html: params.html,
  };
  if (params.text) body.text = params.text;
  if (params.replyTo) body.reply_to = params.replyTo;
  if (params.attachments && params.attachments.length > 0) {
    body.attachments = params.attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content).toString("base64"),
      ...(a.contentType ? { content_type: a.contentType } : {}),
    }));
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ENV.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        `[Email] Resend send failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return { success: false, error: `${response.status} ${response.statusText}` };
    }

    const json = (await response.json().catch(() => ({}))) as { id?: string };
    return { success: true, id: json.id };
  } catch (error) {
    console.error("[Email] Error calling Resend:", error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── HTML helpers ───────────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wrap body HTML in a branded, email-client-safe (inline-styled, table-based)
 * ReconcileAI shell. `bodyHtml` is treated as trusted/pre-rendered HTML.
 */
export function renderBrandedHtml(title: string, bodyHtml: string): string {
  const safeTitle = escapeHtml(title);
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="background-color:${BRAND_NAVY};padding:24px 32px;">
              <span style="display:inline-block;width:36px;height:36px;line-height:36px;text-align:center;background-color:${BRAND_ORANGE};border-radius:8px;color:#ffffff;font-weight:700;font-size:20px;vertical-align:middle;">R</span>
              <span style="color:#ffffff;font-size:18px;font-weight:700;margin-left:12px;vertical-align:middle;">ReconcileAI</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;font-size:15px;line-height:1.6;color:#1f2937;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background-color:#f8fafc;border-top:1px solid #e5e7eb;font-size:12px;color:#94a3b8;">
              © ${year} Infinity AI Africa Limited · ReconcileAI<br />
              This is an automated message — please do not reply unless instructed.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** A primary call-to-action button (inline-styled for email clients). */
export function renderButton(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr><td style="border-radius:8px;background-color:${BRAND_NAVY};">
      <a href="${href}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/**
 * Pragmatic Markdown → HTML converter for the limited Markdown produced by our
 * notification / CFO-report builders: headings (#, ##, ###), **bold**, links,
 * `- ` bullets, `| pipe | tables |`, inline `code`, and paragraph breaks.
 * Not a full CommonMark parser — intentionally small and dependency-free.
 */
export function markdownToBasicHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  const inline = (text: string): string => {
    let s = escapeHtml(text);
    // links [label](url)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
      const safeUrl = (url as string).replace(/"/g, "%22");
      return `<a href="${safeUrl}" style="color:${BRAND_NAVY};">${label}</a>`;
    });
    // bold **text**
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // inline code `code`
    s = s.replace(/`([^`]+)`/g, '<code style="background:#f1f5f9;padding:1px 4px;border-radius:4px;">$1</code>');
    return s;
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "" || trimmed === "---") {
      i++;
      continue;
    }

    // Headings
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const sizes = { 1: "20px", 2: "17px", 3: "15px" } as Record<number, string>;
      out.push(
        `<p style="font-size:${sizes[level]};font-weight:700;color:${BRAND_NAVY};margin:18px 0 8px;">${inline(heading[2])}</p>`
      );
      i++;
      continue;
    }

    // Tables: a header row followed by a |---|---| separator
    if (trimmed.startsWith("|") && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const parseRow = (row: string) =>
        row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const headers = parseRow(trimmed);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      const thead = headers
        .map((h) => `<th style="text-align:left;padding:8px 10px;border-bottom:2px solid ${BRAND_NAVY};font-size:13px;">${inline(h)}</th>`)
        .join("");
      const tbody = rows
        .map(
          (r) =>
            `<tr>${r
              .map((c) => `<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;">${inline(c)}</td>`)
              .join("")}</tr>`
        )
        .join("");
      out.push(
        `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin:12px 0;"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`
      );
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(`<li style="margin:4px 0;">${inline(lines[i].trim().replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul style="margin:8px 0;padding-left:20px;">${items.join("")}</ul>`);
      continue;
    }

    // Paragraph
    out.push(`<p style="margin:8px 0;">${inline(trimmed)}</p>`);
    i++;
  }

  return out.join("\n");
}
