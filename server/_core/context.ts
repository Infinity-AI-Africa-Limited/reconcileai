import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { PORTAL_ORG_HEADER, applyPortalView } from "./portalView";
import { getOrganizationById } from "../db";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  /**
   * The user procedures act as. For a super admin inside a tenant's portal,
   * `organizationId` is the TENANT's — see server/_core/portalView.ts.
   */
  user: User | null;
  /** The account as it signed in, before any portal view. `auth.me` returns this. */
  actor?: User | null;
  /** The tenant a super admin is viewing through the portal, or null. */
  viewingAs?: number | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let signedIn: User | null = null;

  try {
    signedIn = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    signedIn = null;
  }

  // `headers?.` — a caller building a context by hand (tests, internal
  // callers) may pass a request without headers. That must mean "no portal",
  // not an unhandled rejection from inside context creation.
  const view = await applyPortalView(
    signedIn,
    opts.req.headers?.[PORTAL_ORG_HEADER],
    async (id) => Boolean(await getOrganizationById(id)),
  );

  return {
    req: opts.req,
    res: opts.res,
    user: view.user,
    actor: view.actor,
    viewingAs: view.viewingAs,
  };
}
