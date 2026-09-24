/**
 * Where a sign-in link is allowed to point.
 *
 * `auth.requestMagicLink` is a PUBLIC procedure, and its `origin` was a plain
 * `z.string().url()` that went straight into the link this platform emails:
 *
 *   attacker → requestMagicLink({ email: "cfo@bank.com", origin: "https://evil.tld" })
 *   victim   ← a genuine, branded ReconcileAI email containing
 *              https://evil.tld/magic-login?token=<valid single-use token>
 *
 * One click hands the attacker a session as that user. No authentication, no
 * foothold — only the victim's address. The same field reached three other
 * senders (two invite flows and CBS onboarding).
 *
 * The origin is now pinned to APP_URL, with a supplied candidate honoured only
 * when it names the same origin — which is what the real login page sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TRUSTED = "https://www.reconcileaiafrica.com";

/** ENV is read at import, so each case gets a freshly-imported module. */
async function serviceWith(appUrl: string) {
  vi.resetModules();
  // "" means "not configured". Deleting it would NOT work: vi.resetModules()
  // re-imports dotenv/config, which refills APP_URL from the local .env.
  process.env.APP_URL = appUrl;
  return import("./magicLinkService");
}

const originalAppUrl = process.env.APP_URL;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
});

describe("when a caller supplies the origin for a sign-in link", () => {
  it("should refuse an origin that is not this deployment", async () => {
    const { resolveMagicLinkOrigin } = await serviceWith(TRUSTED);

    for (const hostile of [
      "https://evil.tld",
      "http://evil.tld",
      "https://www.reconcileaiafrica.com.evil.tld", // suffix trick
      "https://evil.tld/www.reconcileaiafrica.com", // path trick
      "https://reconcileaiafrica.com.co",
      "//evil.tld",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(resolveMagicLinkOrigin(hostile), hostile).toBe(TRUSTED);
    }
    expect(warn).toHaveBeenCalled();
  });

  it("should accept the origin the real login page sends", async () => {
    const { resolveMagicLinkOrigin } = await serviceWith(TRUSTED);
    // Login.tsx sends window.location.origin.
    expect(resolveMagicLinkOrigin(TRUSTED)).toBe(TRUSTED);
    expect(warn).not.toHaveBeenCalled();
  });

  it("should normalise a candidate that names the same origin differently", async () => {
    const { resolveMagicLinkOrigin } = await serviceWith(TRUSTED);
    for (const same of [`${TRUSTED}/`, `${TRUSTED}/login`, `${TRUSTED}/?next=/home`]) {
      expect(resolveMagicLinkOrigin(same), same).toBe(TRUSTED);
    }
  });

  it("should treat a different scheme or port as a different origin", async () => {
    const { resolveMagicLinkOrigin } = await serviceWith(TRUSTED);
    // An http link for an https deployment puts the token on the wire in clear.
    expect(resolveMagicLinkOrigin("http://www.reconcileaiafrica.com")).toBe(TRUSTED);
    expect(resolveMagicLinkOrigin("https://www.reconcileaiafrica.com:8443")).toBe(TRUSTED);
  });

  it("should fall back to the deployment's own origin when nothing is supplied", async () => {
    const { resolveMagicLinkOrigin } = await serviceWith(TRUSTED);
    expect(resolveMagicLinkOrigin()).toBe(TRUSTED);
    expect(resolveMagicLinkOrigin(null)).toBe(TRUSTED);
    expect(resolveMagicLinkOrigin("   ")).toBe(TRUSTED);
  });

  it("should honour an on-premise APP_URL, trailing slash and all", async () => {
    const { resolveMagicLinkOrigin } = await serviceWith("https://reconcile.bank.internal/");
    expect(resolveMagicLinkOrigin("https://reconcile.bank.internal")).toBe("https://reconcile.bank.internal");
    expect(resolveMagicLinkOrigin("https://evil.tld")).toBe("https://reconcile.bank.internal");
  });

  it("should STILL refuse the caller when APP_URL is unset", async () => {
    // The dangerous branch: a configuration slip must not become "trust the
    // caller". Greptile P1 on this PR — the earlier version returned the
    // candidate here, which left the whole takeover intact on any deployment
    // that had not set APP_URL.
    const { resolveMagicLinkOrigin } = await serviceWith("");
    const { DEFAULT_APP_ORIGIN } = await import("@shared/appOrigin");

    expect(resolveMagicLinkOrigin("https://evil.tld")).toBe(DEFAULT_APP_ORIGIN);
    expect(resolveMagicLinkOrigin()).toBe(DEFAULT_APP_ORIGIN);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("APP_URL is not set"));
  });
});

describe("when the service builds the link itself", () => {
  it("should never interpolate a raw origin parameter", async () => {
    // The senders take `origin` as a parameter; a future one must not template
    // it directly. Both link builders go through the resolver.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.join(__dirname, "magicLinkService.ts"), "utf8");

    const builds = src.match(/const magicLink = `[^`]+`/g) ?? [];
    expect(builds.length).toBeGreaterThan(0);
    for (const line of builds) {
      expect(line, line).toContain("resolveMagicLinkOrigin(");
      expect(line, line).not.toMatch(/\$\{\s*origin\s*\}/);
    }
  });
});

/**
 * The link a SENDER actually produces.
 *
 * The tests above exercise the resolver and the service's source text. Greptile's
 * P2 on this PR: neither proves what lands in the recipient's inbox — a sender
 * could still build an unsafe link while both pass. This drives
 * `sendLoginLinkEmail` end to end with a hostile origin and reads the captured
 * email, which is the boundary that actually matters.
 */
describe("when a sender emails a sign-in link", () => {
  const TRUSTED = "https://www.reconcileaiafrica.com";

  async function sendWith(origin: string, appUrl = TRUSTED) {
    vi.resetModules();
    process.env.APP_URL = appUrl;

    const sent: Array<{ to: string; html: string; text: string }> = [];
    vi.doMock("./_core/email", () => ({
      sendEmail: async (m: any) => {
        sent.push(m);
        return { success: true };
      },
      renderBrandedHtml: (_s: string, body: string) => body,
      renderButton: (_label: string, url: string) => `<a href="${url}">go</a>`,
      escapeHtml: (s: string) => s,
    }));

    // A drizzle stand-in: one active user, and an insert that swallows the token.
    const user = { id: 7, email: "cfo@bank.com", name: "CFO", role: "admin", isActive: true, isGuest: false };
    vi.doMock("./db", () => ({
      getDb: async () => ({
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [user] }) }) }),
        insert: () => ({ values: async () => undefined }),
      }),
    }));

    const { sendLoginLinkEmail } = await import("./magicLinkService");
    await sendLoginLinkEmail({ email: user.email, origin });
    vi.doUnmock("./_core/email");
    vi.doUnmock("./db");
    return sent;
  }

  async function sendWelcomeWith(origin: string, appUrl = TRUSTED) {
    vi.resetModules();
    process.env.APP_URL = appUrl;
    vi.doMock("./_core/email", () => ({
      sendEmail: async () => ({ success: true }),
      renderBrandedHtml: (_s: string, body: string) => body,
      renderButton: (_l: string, url: string) => `<a href="${url}">go</a>`,
      escapeHtml: (s: string) => s,
    }));
    vi.doMock("./db", () => ({
      getDb: async () => ({
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
        insert: () => ({ values: async () => undefined }),
      }),
    }));
    const { sendWelcomeEmail } = await import("./magicLinkService");
    const { magicLink } = await sendWelcomeEmail({
      userId: 7,
      name: "CFO",
      email: "cfo@bank.com",
      role: "admin",
      origin,
    });
    vi.doUnmock("./_core/email");
    vi.doUnmock("./db");
    return { welcomeLink: magicLink };
  }

  /** Every URL in the email body and text part. */
  const linksIn = (m: { html: string; text: string }) =>
    [...`${m.html} ${m.text}`.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(x => x[0]);

  it("should point the emailed link at this deployment, not the caller's host", async () => {
    const [mail] = await sendWith("https://evil.tld");
    expect(mail).toBeDefined();

    const links = linksIn(mail);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(new URL(link).origin, link).toBe(TRUSTED);
      expect(link).not.toContain("evil.tld");
    }
    // And the token really is in there — otherwise this would pass vacuously.
    expect(links.some(l => /\/magic-login\?token=[0-9a-f]{16,}/.test(l))).toBe(true);
  });

  it("should point the WELCOME link there too — both senders, not just the one", async () => {
    // Found by mutation: breaking the welcome sender left the behavioural test
    // green because it only drove the login sender. Greptile's P2 says "either
    // email sender", and it meant it.
    const { welcomeLink } = await sendWelcomeWith("https://evil.tld");
    expect(new URL(welcomeLink).origin).toBe(TRUSTED);
    expect(welcomeLink).not.toContain("evil.tld");
    expect(welcomeLink).toMatch(/\/magic-login\?token=[0-9a-f]{16,}/);
  });

  it("should do the same when APP_URL is not configured", async () => {
    const { DEFAULT_APP_ORIGIN } = await import("@shared/appOrigin");
    const [mail] = await sendWith("https://evil.tld", "");
    for (const link of linksIn(mail)) {
      expect(new URL(link).origin, link).toBe(DEFAULT_APP_ORIGIN);
    }
  });
});
