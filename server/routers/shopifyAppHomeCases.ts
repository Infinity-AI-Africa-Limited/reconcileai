import { TRPCError } from "@trpc/server";
import { shopifyCaseDetailInput, shopifyCaseListInput } from "../../shared/shopifyAppHomeCases";
import { detailShopifyCase, listShopifyCases, ShopifyCaseReadError } from "../connectors/shopify/appHomeCases";
import type { getDb } from "../db";
import type { embeddedProcedure } from "./shopifyAppHome";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Same fresh-token procedure builder; no platform user adapter or mutations. */
export function createShopifyCaseProcedures(procedure: typeof embeddedProcedure, database: () => Promise<Db>) {
  async function safe<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      const missing = error instanceof ShopifyCaseReadError && error.code === "not_found";
      // Static messages only, no cause retained and no raw operational logging.
      throw new TRPCError({ code: missing ? "NOT_FOUND" : "SERVICE_UNAVAILABLE", message: missing ? "not_found" : "unavailable" });
    }
  }
  return {
    exceptionList: procedure.input(shopifyCaseListInput).query(({ ctx, input }) =>
      safe(async () => listShopifyCases(await database(), ctx.shopify, input))),
    exceptionDetail: procedure.input(shopifyCaseDetailInput).query(({ ctx, input }) =>
      safe(async () => detailShopifyCase(await database(), ctx.shopify, input.caseId))),
  };
}
