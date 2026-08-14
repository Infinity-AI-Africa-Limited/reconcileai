/**
 * Tenant scoping on the live job-progress stream.
 *
 * The fourth place tenancy went missing, and the only one outside every
 * existing ratchet's reach: `tenancyRatchet` and `readScopeRatchet` scan db.ts
 * and routers.ts, and this lived in an Express handler in `_core/index.ts`.
 *
 * `GET /api/monitoring/stream` authenticated the caller and then subscribed
 * them to the process-wide EventEmitter, so every connected dashboard received
 * every tenant's job progress. The payload is not innocuous — phase messages
 * read "Completed: 84,229 matched, 11 exceptions, 92.3% match rate", so a bank
 * watched a competitor's volumes and match quality in real time.
 *
 * Reported as a P0 confidentiality defect in the external Financial-Services
 * Deployment Readiness Assessment (12 Aug 2026) against commit de61cec, and
 * confirmed exactly as described.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mayReceiveJobEvent, emitJobProgress, jobEvents, type JobProgressEvent } from "./jobEvents";

const evt = (organizationId: number | null): Pick<JobProgressEvent, "organizationId"> => ({ organizationId });

describe("when a job-progress event is offered to a connected dashboard", () => {
  it("should deliver it to the tenant that owns the job", () => {
    expect(mayReceiveJobEvent(evt(1), 1)).toBe(true);
  });

  it("should NOT deliver another tenant's event", () => {
    expect(mayReceiveJobEvent(evt(1), 60001)).toBe(false);
    expect(mayReceiveJobEvent(evt(60001), 1)).toBe(false);
  });

  it("should not leak a tenant's event to an org-less viewer", () => {
    // 22 accounts currently have no organisation. Treating "no org" as a
    // wildcard would pool every one of them into a view of the whole platform.
    expect(mayReceiveJobEvent(evt(1), null)).toBe(false);
  });

  it("should not leak an org-less job to a tenant", () => {
    expect(mayReceiveJobEvent(evt(null), 1)).toBe(false);
  });

  it("should match org-less job to org-less viewer, as orgFilter does", () => {
    expect(mayReceiveJobEvent(evt(null), null)).toBe(true);
  });

  it("should give no role a bypass", () => {
    // Deliberately no super-admin escape hatch: staff inspect one tenant by
    // entering its portal, which is the line navFor already draws. A live
    // firehose of every tenant's activity is not a default anyone needs.
    const forAllViewers = [1, 60001, null].map((v) => mayReceiveJobEvent(evt(30002), v));
    expect(forAllViewers).toEqual([false, false, false]);
  });
});

describe("when a progress event reaches the bus", () => {
  it("should carry the owning tenant end to end", async () => {
    const seen: JobProgressEvent[] = [];
    const listener = (e: unknown) => seen.push(e as JobProgressEvent);
    jobEvents.on("progress", listener);
    try {
      emitJobProgress({
        jobId: 42,
        organizationId: 1,
        phase: "completed",
        progress: 100,
        message: "Completed: 84,229 matched, 11 exceptions, 92.3% match rate",
      });
    } finally {
      jobEvents.off("progress", listener);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].organizationId).toBe(1);
    // The message is exactly why this matters — it is the reconciliation result.
    expect(seen[0].message).toContain("matched");
  });
});

describe("the stream endpoint applies the rule", () => {
  // A predicate nothing calls is decoration, the same reason routeAccess.test
  // asserts App.tsx wires SegmentGuard.
  const INDEX = fs.readFileSync(path.join(__dirname, "_core", "index.ts"), "utf8");
  const stream = INDEX.slice(
    INDEX.indexOf('app.get("/api/monitoring/stream"'),
    INDEX.indexOf("registerStorageProxy(app)"),
  );

  it("should read the viewer's organisation from the authenticated user", () => {
    expect(stream).toMatch(/viewerOrganizationId = user\.organizationId \?\? null/);
  });

  it("should filter every event before writing it to the socket", () => {
    expect(stream).toMatch(/if \(!mayReceiveJobEvent\(event, viewerOrganizationId\)\) return;/);
  });

  it("should not write an unfiltered payload", () => {
    // The original line spread the payload straight into res.write.
    expect(stream).not.toMatch(/\.\.\.\(payload as object\)/);
  });
});

describe("progress events resolve their tenant without the caller's help", () => {
  const SERVICE = fs.readFileSync(path.join(__dirname, "jobProgressService.ts"), "utf8");

  it("should look the organisation up from the jobId", () => {
    // Threading it through trackProgress's signature would mean every one of
    // its scattered call sites had to remember; one omission restores the leak.
    expect(SERVICE).toMatch(/const owner = await organizationForJob\(jobId\)/);
  });

  /**
   * An unresolved owner must reach NOBODY.
   *
   * The first fix returned a bare `number | null` and reasoned that an
   * unresolvable job "yields null, which only an org-less viewer matches" —
   * calling that fail-closed. It is not. `null` is a real tenancy bucket with 22
   * accounts in it, so an unresolved job was broadcast to every one of them: it
   * failed OPEN toward the viewers least entitled to it. Caught by review on
   * PR #78.
   *
   * Same mistake, different pair, as "no organisation is not an unknown segment"
   * in shared/verticalFeatures. Absence of an answer is not an answer.
   */
  it("should distinguish an unknown owner from a genuinely org-less job", () => {
    expect(SERVICE).toMatch(/known: true; organizationId: number \| null/);
    expect(SERVICE).toMatch(/known: false; organizationId: null/);
  });

  it("should emit only when the owner is known", () => {
    expect(SERVICE).toMatch(/if \(owner\.known\) \{/);
    // The old shape collapsed both cases into one nullable value.
    expect(SERVICE).not.toMatch(/organizationId: await organizationForJob/);
  });

  it("should treat a missing job as unknown, not as org-less", () => {
    expect(SERVICE).toMatch(/if \(!job\) return UNKNOWN_OWNER;/);
  });

  it("should survive a transient database failure without guessing", () => {
    // A throw must not be read as "this job has no organisation".
    const body = SERVICE.slice(SERVICE.indexOf("async function organizationForJob"));
    expect(body).toMatch(/catch \{\s*return UNKNOWN_OWNER;/);
  });

  it("should never cache an unresolved lookup", () => {
    // Caching a failed lookup pins the wrong answer to that job for the life of
    // the process — one transient error becomes a permanent mislabel.
    const body = SERVICE.slice(
      SERVICE.indexOf("async function organizationForJob"),
      SERVICE.indexOf("function getNextPhaseProgress"),
    );
    const cacheWrites = [...body.matchAll(/jobOrgCache\.set\(/g)];
    expect(cacheWrites).toHaveLength(1);
    // The single write sits after the not-found guard, so only resolved owners reach it.
    expect(body.indexOf("jobOrgCache.set(")).toBeGreaterThan(body.indexOf("if (!job) return UNKNOWN_OWNER;"));
  });
});
