import { describe, expect, it } from "vitest";
import {
  SHOPIFY_EXCEPTION_WORKSPACE_HANDOFF,
  SHOPIFY_EXCEPTION_WORKSPACE_PATH,
} from "./shopifyExceptionHandoff";

describe("Shopify exception workspace handoff", () => {
  it("opens only the fixed top-level exception workspace without a Shopify identity or tenant context", () => {
    expect(SHOPIFY_EXCEPTION_WORKSPACE_PATH).toBe("/exceptions");
    expect(SHOPIFY_EXCEPTION_WORKSPACE_HANDOFF).toEqual({
      href: "/exceptions",
      target: "_top",
      rel: "noreferrer",
    });
    expect(SHOPIFY_EXCEPTION_WORKSPACE_HANDOFF.href).not.toContain("?");
    expect(SHOPIFY_EXCEPTION_WORKSPACE_HANDOFF.href).not.toContain("#");
  });
});
