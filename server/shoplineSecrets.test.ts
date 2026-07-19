/**
 * Validates that the SHOPLINE Partner Portal credentials are correctly
 * configured in the environment. These are non-network tests — they only
 * verify the env vars are present and have the expected format.
 */
import { describe, it, expect } from "vitest";

describe("SHOPLINE secrets validation", () => {
  it("SHOPLINE_APP_KEY is set and has correct format (40-char hex)", () => {
    const key = process.env.SHOPLINE_APP_KEY;
    expect(key).toBeDefined();
    expect(key!.length).toBe(40);
    expect(/^[0-9a-f]{40}$/.test(key!)).toBe(true);
  });

  it("SHOPLINE_APP_SECRET is set and has correct format (40-char hex)", () => {
    const secret = process.env.SHOPLINE_APP_SECRET;
    expect(secret).toBeDefined();
    expect(secret!.length).toBe(40);
    expect(/^[0-9a-f]{40}$/.test(secret!)).toBe(true);
  });

  it("SHOPLINE_WEBHOOK_SECRET is set and matches APP_SECRET (SHOPLINE convention)", () => {
    const webhookSecret = process.env.SHOPLINE_WEBHOOK_SECRET;
    const appSecret = process.env.SHOPLINE_APP_SECRET;
    expect(webhookSecret).toBeDefined();
    expect(webhookSecret).toBe(appSecret);
  });
});
