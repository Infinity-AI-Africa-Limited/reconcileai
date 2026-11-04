import type { RequestHandler } from "express";
import { applicationLifecycle, type ApplicationLifecycle, MaintenanceAdmissionError } from "./lifecycle";

/** Fail closed for ALL paths except two exact, dependency-free GET probes. */
export function maintenanceAdmission(lifecycle: ApplicationLifecycle = applicationLifecycle): RequestHandler {
  return (req, res, next) => {
    if (req.method === "GET" && (req.path === "/api/healthz" || req.path === "/api/readyz")) {
      next();
      return;
    }
    if (!lifecycle.isAcceptingWork()) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", "60");
      res.status(503).json({ code: "maintenance_unavailable" });
      return;
    }
    try {
      const lease = lifecycle.enterRequest(() => next());
      // Response/socket lifetime is one tracked scope. Async handlers and detached
      // tasks ALSO track their promises, so an early response is not completion proof.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        res.off("finish", release);
        res.off("close", release);
        lease.release();
      };
      res.once("finish", release);
      res.once("close", release);
      // A downstream synchronous handler can finish before listeners were installed.
      if (res.writableEnded || res.destroyed) release();
    } catch (error) {
      if (!(error instanceof MaintenanceAdmissionError)) { next(error); return; }
      res.setHeader("Retry-After", "60");
      res.status(503).json({ code: "maintenance_unavailable" });
    }
  };
}
