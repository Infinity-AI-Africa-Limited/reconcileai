import type { Express } from "express";
import { storageGet, orgIdFromKey } from "../storage";
import { sdk } from "./sdk";

/**
 * Storage proxy — serves /manus-storage/<key> by redirecting to a fresh presigned
 * S3/R2 URL. Gives durable, non-expiring links in the UI (each request re-presigns)
 * regardless of the underlying object store. Route name kept for backward
 * compatibility with any URLs already persisted from the prototype.
 *
 * Access control (PCI remediation, gap-closure plan WS-2):
 *   1. AUTHENTICATION — a valid session is required. Previously any holder of a
 *      key string could fetch the object (reports, exports, uploads).
 *   2. OWNER ACL — keys under the org-scoped convention (`org/<id>/...`, see
 *      orgScopedKey in server/storage.ts) are only served to members of that
 *      organization (super admins excepted). Legacy un-prefixed keys are served
 *      to any authenticated user (documented caveat — new writes must use the
 *      convention).
 *   3. AUDIT — every access is logged (actor, key, decision).
 */
export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/:key(*)", async (req, res) => {
    const key = req.params.key;
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }

    // 1. Authentication — same session check as the tRPC context.
    let user: Awaited<ReturnType<typeof sdk.authenticateRequest>> | null = null;
    try {
      user = await sdk.authenticateRequest(req);
    } catch {
      user = null;
    }
    if (!user) {
      res.status(401).send("Authentication required");
      return;
    }

    // 2. Owner ACL for org-scoped keys.
    const keyOrgId = orgIdFromKey(key);
    const allowed =
      keyOrgId === null ||
      user.role === "super_admin" ||
      user.organizationId === keyOrgId;

    // 3. Audit the access decision (best-effort; never blocks the response).
    void (async () => {
      try {
        const { createAuditLog } = await import("../db");
        await createAuditLog({
          userId: user!.id,
          action: allowed ? "storage_access" : "storage_access_denied",
          entityType: "storage_object",
          details: JSON.stringify({ key: key.slice(0, 400), keyOrgId }),
          ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || null,
          userAgent: (req.headers["user-agent"] || "").toString().substring(0, 500) || null,
        });
      } catch { /* audit is best-effort here */ }
    })();

    if (!allowed) {
      res.status(403).send("You do not have access to this object");
      return;
    }

    try {
      const { url } = await storageGet(key);
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}
