/**
 * SLA alerting must never report fabricated data as a real breach.
 *
 * The incident this pins: on 2026-08-14 the owner received
 * "⚠️ SLA Breach Alert: 374 Exceptions Require Attention" listing 357 breached
 * and 17 approaching, every one of them seeded demo data on
 * "Globus Bank Nigeria (Demo)". The email's own footer read "Demo data
 * exceptions are excluded from this alert."
 *
 * Cause: demo-ness was inferred by CASE-SENSITIVE substring matching on
 * reconciliation job names — "Demo", "demo", "vs CBS GL", "BrightGoods",
 * "Demo Reconciliation". The seeder named its jobs
 * "… vs Core Banking — FSDEMO-v2", and `"FSDEMO".includes("Demo")` is false, so
 * every pattern missed.
 *
 * The lesson is not "add FSDEMO to the list". It is that a guard keyed on
 * free-text names each seeder invents will keep failing, so the fact moved to
 * `organizations.isDemo`.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { realOrganizations } from "./slaMonitoringService";

const org = (id: number, name: string, isDemo: boolean) => ({ id, name, isDemo });

describe("when deciding which organisations SLA alerts cover", () => {
  const ORGS = [
    org(1, "Globus Bank Nigeria (Demo)", true),
    org(30001, "BrightGoods Nigeria Ltd (Demo)", true),
    org(60001, "ReconcileAI Dev Store", true),
    org(70001, "TAJBank Limited", false),
    org(70002, "Globus Bank Plc", false),
  ];

  it("should exclude every demo tenant", () => {
    const real = realOrganizations(ORGS);
    expect(real.has(1)).toBe(false);
    expect(real.has(30001)).toBe(false);
    expect(real.has(60001)).toBe(false);
  });

  it("should include real clients", () => {
    const real = realOrganizations(ORGS);
    expect(real.get(70001)).toBe("TAJBank Limited");
    expect(real.get(70002)).toBe("Globus Bank Plc");
  });

  it("should not confuse a real bank with a demo one sharing its name", () => {
    // "Globus Bank Nigeria (Demo)" and "Globus Bank Plc" differ only by marker.
    // Keying on the flag rather than the name is what keeps them apart.
    const real = realOrganizations(ORGS);
    expect(real.size).toBe(2);
    expect([...real.values()]).not.toContain("Globus Bank Nigeria (Demo)");
  });

  it("should alert on nobody when every tenant is a demo", () => {
    // Today's actual state. The correct output is an empty alert, not 374 rows.
    expect(realOrganizations(ORGS.filter((o) => o.isDemo)).size).toBe(0);
  });

  it("should treat a demo tenant as demo regardless of what its jobs are called", () => {
    // The regression, stated directly: the job name is now irrelevant.
    expect(realOrganizations([org(1, "Anything At All", true)]).size).toBe(0);
  });
});

describe("the service no longer guesses demo-ness from job names", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "slaMonitoringService.ts"), "utf8");
  /**
   * Comments stripped, because the file's own docstring quotes the old patterns
   * in order to explain the incident. Asserting against the raw text would flag
   * the explanation as the offence — and deleting the explanation to satisfy a
   * test is exactly the wrong repair.
   */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("should read organizations.isDemo", () => {
    expect(CODE).toMatch(/isDemo: organizations\.isDemo/);
  });

  it("should not substring-match job names for demo markers", () => {
    // Each of these was a pattern in the old filter. Any one returning would
    // reintroduce a guard that the next seeder's naming can defeat.
    for (const pattern of ['includes("Demo")', 'includes("demo")', '"vs CBS GL"', '"BrightGoods"', '"Demo Reconciliation"']) {
      expect(CODE, `demo detection must not depend on ${pattern}`).not.toContain(pattern);
    }
  });

  it("should not import reconciliationJobs at all", () => {
    // The old implementation loaded every job on the platform purely to
    // pattern-match its name.
    expect(CODE).not.toMatch(/reconciliationJobs/);
  });

  it("should scope the exception query by organizationId", () => {
    // The scan previously selected every exception on the platform with no
    // tenancy predicate whatsoever.
    expect(SRC).toMatch(/inArray\(exceptions\.organizationId/);
  });

  it("should put the tenancy predicate in the QUERY, not a post-filter", () => {
    const body = CODE.slice(CODE.indexOf("const openExceptions"), CODE.indexOf("const breaches"));
    expect(body).toMatch(/\.where\(\s*and\(/);
    expect(body).toMatch(/inArray/);
  });
});

describe("the alert email states its scope honestly", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "slaMonitoringService.ts"), "utf8");

  it("should name the mechanism rather than assert exclusion happened", () => {
    // The old footer promised "Demo data exceptions are excluded from this
    // alert" while the alert was made almost entirely OF demo data. A promise
    // the reader cannot check is worse than none.
    expect(SRC).not.toContain("Note: Demo data exceptions are excluded from this alert.");
    expect(SRC).toMatch(/organizations\.isDemo\) are excluded/);
  });

  it("should attribute every breach to its organisation", () => {
    expect(SRC).toMatch(/\$\{b\.organizationName\} · Exception #\$\{b\.exceptionId\}/);
  });

  it("should summarise per organisation before listing ids", () => {
    expect(SRC).toContain("By organisation:");
  });

  it("should show the oldest breaches first, not the lowest ids", () => {
    expect(SRC).toMatch(/\.sort\(\(a, b\) => b\.hoursOpen - a\.hoursOpen\)/);
  });
});
