import { describe, expect, it } from "vitest";
import {
  SHOPIFY_EXCEPTION_WORKSPACE_PATH,
  shopifyExceptionWorkspaceHandoff,
} from "./shopifyExceptionHandoff";

const PRODUCTION = "https://www.reconcileaiafrica.com";

describe("when a merchant leaves Shopify App Home for the exception workspace", () => {
  it("should link to the fixed Payment Exceptions path on the page's own origin", () => {
    expect(SHOPIFY_EXCEPTION_WORKSPACE_PATH).toBe("/exceptions");
    expect(shopifyExceptionWorkspaceHandoff(PRODUCTION)?.href).toBe(`${PRODUCTION}/exceptions`);
  });

  it("should carry no query, fragment, credential or other context into the workspace", () => {
    const href = new URL(shopifyExceptionWorkspaceHandoff(PRODUCTION)!.href);
    expect(href.search).toBe("");
    expect(href.hash).toBe("");
    expect(href.username).toBe("");
    expect(href.password).toBe("");
    expect(href.pathname).toBe("/exceptions");
  });

  it("should open in a new top-level tab without a referrer or an opener", () => {
    // Shopify: `_blank` for a destination outside the embedded app, which also
    // keeps Admin open. App Home's URL carries Shopify session parameters.
    const handoff = shopifyExceptionWorkspaceHandoff(PRODUCTION)!;
    expect(handoff.target).toBe("_blank");
    expect(handoff.rel.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  });

  it("should be absolute, so App Bridge cannot route it as a page of the embedded app", () => {
    expect(shopifyExceptionWorkspaceHandoff(PRODUCTION)!.href).toMatch(/^https:\/\//);
  });
});

describe("when the page's origin is not one to send a merchant to", () => {
  it.each([
    ["a sandboxed frame's opaque origin", "null"],
    ["an empty origin", ""],
    ["plain http on a public host", "http://www.reconcileaiafrica.com"],
    ["a non-web scheme", "file:///"],
    ["an origin with a path", `${PRODUCTION}/shopify/app`],
    ["an origin with a query", `${PRODUCTION}?shop=merchant.myshopify.com`],
    ["an origin with a trailing slash", `${PRODUCTION}/`],
    ["an origin with credentials", "https://user:pass@www.reconcileaiafrica.com"],
  ])("should offer no link for %s", (_case, origin) => {
    expect(shopifyExceptionWorkspaceHandoff(origin)).toBeNull();
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:5173", "http://[::1]:3000"])(
    "should still link on the local development host %s",
    (origin) => {
      expect(shopifyExceptionWorkspaceHandoff(origin)?.href).toBe(`${origin}/exceptions`);
    }
  );
});
