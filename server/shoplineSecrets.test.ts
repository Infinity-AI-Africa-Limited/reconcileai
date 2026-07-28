/**
 * Format guard for the SHOPLINE Partner Portal credentials.
 *
 * These are deploy-time secrets injected in production (and not present in CI
 * or local dev), so the suite must NOT hard-fail when they are absent — it only
 * asserts the FORMAT when a value is set, catching a malformed paste without
 * coupling the test run to having real portal secrets on hand.
 */
import { describe, it, expect } from "vitest";

const APP_KEY = process.env.SHOPLINE_APP_KEY;
const APP_SECRET = process.env.SHOPLINE_APP_SECRET;
const WEBHOOK_SECRET = process.env.SHOPLINE_WEBHOOK_SECRET;

// SHOPLINE issues 40-char lowercase-hex app keys/secrets.
const HEX40 = /^[0-9a-f]{40}$/;

describe("SHOPLINE secrets format guard", () => {
  it("SHOPLINE_APP_KEY, when set, is 40-char hex", () => {
    if (!APP_KEY) return; // not injected in this environment — nothing to validate
    expect(APP_KEY).toMatch(HEX40);
  });

  it("SHOPLINE_APP_SECRET, when set, is 40-char hex", () => {
    if (!APP_SECRET) return;
    expect(APP_SECRET).toMatch(HEX40);
  });

  it("SHOPLINE_WEBHOOK_SECRET, when set, equals APP_SECRET (SHOPLINE uses one key)", () => {
    if (!WEBHOOK_SECRET && !APP_SECRET) return;
    // If either is present, the convention is that they match.
    expect(WEBHOOK_SECRET).toBe(APP_SECRET);
  });
});
