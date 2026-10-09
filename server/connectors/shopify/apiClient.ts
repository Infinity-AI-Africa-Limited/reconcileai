import { assertEgressAllowed } from "../../_core/egress";
import { SHOPIFY_API_VERSION } from "../../../drizzle/shopify_schema";
import { normalizeShopDomain } from "./auth";
import type { ShopifyShopMetadata } from "./onboarding";

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
}

function endpointFor(shopDomain: string): string {
  const normalized = normalizeShopDomain(shopDomain);
  if (!normalized) throw new Error("Invalid Shopify shop domain");
  return `https://${normalized}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

/**
 * Minimal metadata lookup that deliberately omits order, customer and payment
 * fields. It obtains a store-owned contact address for the initial invited
 * administrator, rather than trusting a request's query parameter.
 */
export async function fetchShopifyShopMetadata(params: {
  shopDomain: string;
  accessToken: string;
}): Promise<ShopifyShopMetadata> {
  const endpoint = endpointFor(params.shopDomain);
  assertEgressAllowed(endpoint, "Shopify shop metadata lookup");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Shopify-Access-Token": params.accessToken,
    },
    body: JSON.stringify({
      query: `query ReconcileAIShopMetadata {
        shop {
          id
          name
          contactEmail
          currencyCode
          ianaTimezone
          primaryDomain { host }
        }
      }`,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Shopify metadata lookup failed (${response.status})`);
  const body = (await response.json()) as GraphqlResponse<{
    shop?: {
      id?: string;
      name?: string;
      contactEmail?: string;
      currencyCode?: string;
      ianaTimezone?: string;
      primaryDomain?: { host?: string | null } | null;
    };
  }>;
  if (body.errors?.length || !body.data?.shop?.id || !body.data.shop.name || !body.data.shop.contactEmail) {
    // Shopify's error text is not ours to log; its structured code is enough to diagnose.
    const code = body.errors?.[0]?.extensions?.code;
    throw new Error(`Shopify returned incomplete shop metadata${code && /^[A-Z_]{1,64}$/.test(code) ? ` (${code})` : ""}`);
  }
  return {
    id: body.data.shop.id,
    name: body.data.shop.name,
    contactEmail: body.data.shop.contactEmail,
    primaryDomain: body.data.shop.primaryDomain?.host ?? null,
    currencyCode: body.data.shop.currencyCode ?? null,
    ianaTimezone: body.data.shop.ianaTimezone ?? null,
  };
}
