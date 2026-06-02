import type { Express, Request, Response } from "express";

/**
 * Manus OAuth has been removed in favour of email / magic-link authentication
 * (see server/magicLinkService.ts and the `auth.requestMagicLink` procedure).
 *
 * This handler is retained only to gracefully redirect any stale OAuth callback
 * links (browser bookmarks, cached redirects, old emails) to the new sign-in
 * page instead of returning an error. It performs no network calls.
 */
export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", (_req: Request, res: Response) => {
    res.redirect(302, "/login");
  });
}
