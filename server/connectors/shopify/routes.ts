import express from "express";
import { sdk } from "../../_core/sdk";
import { getDb } from "../../db";
import { normalizeShopDomain } from "./auth";
import {
  PrivacyArtifactIntegrityError,
  authorizeAndReadPrivacyArtifact,
  confirmPrivacyArtifactDeliveryWithRetry,
  loadPrivacyArtifactForDownload,
} from "./privacyCompletion";
import type { ShopifyInstallErrorReason } from "@shared/shopifyInstall";
import { SHOPIFY_OAUTH_CALLBACK_PATH, SHOPIFY_RETIRED_INSTALL_PATH } from "./paths";

/** The cookie the retired authorization-code path set; cleared if a browser still holds one. */
const RETIRED_FLOW_COOKIE = "shopify_oauth_flow";

function installError(res: express.Response, reason: ShopifyInstallErrorReason): void {
  res.redirect(302, `/shopify/error?reason=${encodeURIComponent(reason)}`);
}

/**
 * Shopify HTTP routes that are not tRPC: a privacy-artifact download, and the
 * retired authorization-code install path.
 *
 * Every `await` sits inside a try. Express 4 does not catch a rejected async
 * handler, and this server registers no `unhandledRejection` handler, so on
 * Node 22 one database error escaping a route would exit the process.
 */
export function createShopifyRouter(): express.Router {
  const router = express.Router();

  router.get("/api/shopify/privacy/artifacts/:publicId", async (req, res) => {
    res.set("Cache-Control", "no-store, private, max-age=0");
    res.set("Pragma", "no-cache");
    const publicId = req.params.publicId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicId)) {
      return res.status(404).send("Artifact unavailable");
    }
    try {
      const actor = await sdk.authenticateRequest(req);
      const db = await getDb();
      if (!db) return res.status(503).send("Temporarily unavailable");
      const artifact = await loadPrivacyArtifactForDownload(db, publicId);
      const prepared = artifact
        ? await authorizeAndReadPrivacyArtifact({
            db,
            actor: {
              id: actor.id,
              organizationId: actor.organizationId,
              role: actor.role,
              isActive: actor.isActive,
            },
            artifact,
          })
        : null;
      if (!artifact || !prepared) return res.status(403).send("Artifact unavailable");

      // The server sends the bytes itself, and delivery is confirmed only once
      // every byte has been handed to the network ('finish'). A client that
      // disconnects first fires 'close' without 'finish': nothing is completed,
      // the selectors survive, and the artifact stays downloadable. (A redirect
      // to a presigned URL gave no such evidence — it counted as delivery before
      // the browser had fetched anything.)
      // A failed confirmation write is retried; if it still fails the export
      // stays downloadable, and expiry records it as served-but-unconfirmed.
      res.once("finish", () => {
        void confirmPrivacyArtifactDeliveryWithRetry(db, artifact, actor.id, new Date())
          .then((outcome) => {
            if (outcome === "not_confirmed") {
              console.warn("[shopify-privacy] delivery sent but not recorded", { code: "delivery_not_confirmed" });
            }
          })
          .catch(() => {
            console.error("[shopify-privacy] DELIVERY CONFIRMATION LOST after retries", {
              code: "delivery_evidence_failed",
              requestId: artifact.requestId,
            });
          });
      });
      res.set("Content-Type", "application/json; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="${prepared.filename}"`);
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Length", String(prepared.bytes.length));
      return res.status(200).end(prepared.bytes);
    } catch (error) {
      // Authentication failures disclose neither artifact existence nor scope.
      if (error instanceof Error && /session|forbidden|user not found|deactivated/i.test(error.message)) {
        return res.status(401).send("Authentication required");
      }
      if (error instanceof PrivacyArtifactIntegrityError) {
        // Never serve bytes that do not match what was written.
        console.error("[shopify-privacy] artifact integrity check failed", { code: "artifact_integrity_failed" });
        return res.status(409).send("Artifact unavailable");
      }
      console.error("[shopify-privacy] artifact access failed", {
        code: "artifact_access_failed",
      });
      return res.status(503).send("Temporarily unavailable");
    }
  });

  // ── The authorization-code install path, retired ───────────────────────────
  //
  // Installation and reconnection are Shopify-managed (managedInstall.ts): App
  // Home verifies a fresh App Bridge ID token and exchanges it server-side, under
  // the install lease, suspension and redaction fence. That covers every store
  // this path used to: a new shop, an uninstalled one, and one whose credentials
  // died. A second way in was a second onboarding path to keep in step, behind
  // an unauthenticated public entry point.
  //
  // Both routes stay mounted only to answer a stale link, or a grant, clearly,
  // and both answer before any database access or network call:
  //   - the install route starts nothing, so no authorization-code grant can
  //     begin here;
  //   - the callback exchanges nothing, so a code Shopify delivers to the
  //     redirect URL shopify.app.toml must still list (the CLI requires one) is
  //     never redeemed.
  router.get(SHOPIFY_RETIRED_INSTALL_PATH, (req, res) => {
    console.warn("[shopify-oauth] retired install route answered", {
      code: "legacy_install_retired",
      shopDomain: normalizeShopDomain(typeof req.query.shop === "string" ? req.query.shop : undefined),
    });
    installError(res, "managed_install_only");
  });

  router.get(SHOPIFY_OAUTH_CALLBACK_PATH, (req, res) => {
    console.warn("[shopify-oauth] retired callback answered; no code exchanged", {
      code: "legacy_callback_retired",
      shopDomain: normalizeShopDomain(typeof req.query.shop === "string" ? req.query.shop : undefined),
    });
    res.clearCookie(RETIRED_FLOW_COOKIE, { path: "/api/shopify" });
    installError(res, "managed_install_only");
  });

  return router;
}
