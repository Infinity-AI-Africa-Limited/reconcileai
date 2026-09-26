/**
 * Keep a rejected async route handler from taking the process down.
 *
 * Express 4 does not catch a rejected handler promise. Nothing in this app
 * registers `process.on("unhandledRejection")`, and Node 22 defaults to
 * `--unhandled-rejections=throw` — so one rejection that escapes a handler
 * exits the process. Railway restarts it (`ON_FAILURE`, ≤10 retries), and a
 * caller that retries — a SHOPLINE webhook, a GitHub-Actions scheduler — turns
 * a single bad request into a restart loop.
 *
 * This is the narrow fix: catch at the boundary, answer the caller, log with
 * the route attached so the next one is diagnosable. It is deliberately NOT a
 * process-level `unhandledRejection` handler that swallows and continues —
 * see the PR for why that trade is wrong for this product.
 *
 * Applied only to handlers with async work outside a `try`; handlers that are
 * `try`-wrapped end to end already answer their own failures.
 * `asyncHandlerRatchet.test.ts` keeps that true as routes are added.
 */
import type { NextFunction, Request, Response } from "express";

export type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * `503` rather than `500` for a scheduler or webhook caller: the request was
 * well-formed and the server failed, so retrying later is the right behaviour
 * and the status should say so. Browsers see a plain 500.
 */
function statusFor(req: Request): number {
  return req.path.startsWith("/api/scheduled/") || req.path.startsWith("/api/webhooks/") ? 503 : 500;
}

export function asyncHandler(fn: AsyncRouteHandler): AsyncRouteHandler {
  return (req, res, next) => {
    let result: unknown;
    try {
      result = fn(req, res, next);
    } catch (err) {
      // A handler can also throw SYNCHRONOUSLY before returning a promise —
      // Express catches that one itself, but only for non-async functions.
      handle(err, req, res);
      return;
    }
    if (result instanceof Promise || (typeof result === "object" && result !== null && "catch" in result)) {
      (result as Promise<unknown>).catch((err: unknown) => handle(err, req, res));
    }
  };
}

function handle(err: unknown, req: Request, res: Response): void {
  console.error(`[asyncHandler] unhandled rejection in ${req.method} ${req.originalUrl || req.path}:`, err);

  // Already streaming (the SSE monitor) or already answered: a second set of
  // headers throws ERR_HTTP_HEADERS_SENT, which would be the very thing this
  // wrapper exists to prevent. End the response instead.
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* the socket is already gone; nothing left to do */
    }
    return;
  }

  try {
    res.status(statusFor(req)).json({ error: "internal_error" });
  } catch {
    // Responding failed too (socket destroyed mid-write). Swallowing here is
    // the point: this function is the last line before the process exits.
  }
}
