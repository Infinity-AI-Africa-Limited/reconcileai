import { describe, expect, it } from "vitest";
import { sanitizeRef } from "./db";

describe("when a reference is a Shopify GID", () => {
  it("should keep it verbatim, colon included, so it can join the order leg", () => {
    expect(sanitizeRef("gid://shopify/Order/5551234567")).toBe("gid://shopify/Order/5551234567");
    expect(sanitizeRef("  gid://shopify/Order/1001 ")).toBe("gid://shopify/Order/1001");
  });

  it("should not treat a look-alike as a GID", () => {
    expect(sanitizeRef("gid://shopify/Order/1001?x=1")).toBe("gid//shopify/Order/1001x1");
    expect(sanitizeRef("gid://evil/Order/1001")).toBe("gid//evil/Order/1001");
  });
});

describe("when a reference comes from any other source", () => {
  it("should store it exactly as it was stored before GIDs were admitted", () => {
    // A colon-bearing bank or gateway reference must not change its stored form
    // across the deploy, or it stops matching and deduping against itself.
    expect(sanitizeRef("NIP:000123")).toBe("NIP000123");
    expect(sanitizeRef("#1001")).toBe("1001");
    expect(sanitizeRef("FT-2026/09.28_01")).toBe("FT-2026/09.28_01");
  });
});
