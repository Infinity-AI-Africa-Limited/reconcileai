import type { Express } from "express";
import { storageGet } from "../storage";

/**
 * Storage proxy — serves /manus-storage/<key> by redirecting to a fresh presigned
 * S3/R2 URL. Gives durable, non-expiring links in the UI (each request re-presigns)
 * regardless of the underlying object store. Route name kept for backward
 * compatibility with any URLs already persisted from the prototype.
 */
export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/:key(*)", async (req, res) => {
    const key = req.params.key;
    if (!key) {
      res.status(400).send("Missing storage key");
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
