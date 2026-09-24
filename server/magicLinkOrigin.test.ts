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
async function serviceWith(appUrl: string | undefined) {
  vi.resetModules();
  if (appUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = appUrl;
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

  it("should say so loudly when APP_URL is unset rather than silently trusting the caller", async () => {
    // Nothing to compare against — behaviour is unchanged, but it is a
    // misconfiguration and the log has to name it.
    const { resolveMagicLinkOrigin } = await serviceWith(undefined);
    expect(resolveMagicLinkOrigin("https://anything.example")).toBe("https://anything.example");
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
