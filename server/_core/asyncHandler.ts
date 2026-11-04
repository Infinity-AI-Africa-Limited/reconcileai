/**
 * Express 4 does not observe rejected handler promises. Catch at the route
 * boundary rather than swallow process-wide unhandled rejections.
 *
 * This wrapper also tracks the handler's actual promise lifetime. It can keep
 * awaiting writes after returning an HTTP response or losing its client socket.
 * Diagnostics contain fixed codes only: URLs may carry credentials, and even
 * non-database rejection messages can contain provider/customer material.
 */
import type { NextFunction, Request, Response } from "express";
import { applicationLifecycle, MaintenanceAdmissionError } from "../maintenance/lifecycle";

export type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => unknown;

function statusFor(req: Request): number {
  return req.path.startsWith("/api/scheduled/") || req.path.startsWith("/api/webhooks/") ? 503 : 500;
}

export function asyncHandler(fn: AsyncRouteHandler): AsyncRouteHandler {
  return (req, res, next) => {
    void applicationLifecycle.run("request", async () => fn(req, res, next))
      .catch((err: unknown) => handle(err, req, res));
  };
}

function handle(err: unknown, req: Request, res: Response): void {
  if (err instanceof MaintenanceAdmissionError) {
    try {
      if (!res.headersSent) {
        res.setHeader("Retry-After", "60");
        res.status(503).json({ code: "maintenance_unavailable" });
      }
    } catch {
      // A disconnected response must not create a new unhandled rejection.
    }
    return;
  }
  const status = statusFor(req);
  console.error("[asyncHandler] route_failure", {
    code: "async_route_failed",
    boundary: status === 503 ? "retryable" : "interactive",
  });
  if (res.headersSent) {
    try { res.end(); } catch { /* the socket is already gone */ }
    return;
  }
  try {
    res.status(status).json({ error: "internal_error" });
  } catch {
    // Last failure boundary: never throw while trying to answer a failed caller.
  }
}
