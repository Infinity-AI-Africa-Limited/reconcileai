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
import { OPERATOR_ORG_CODE, formatSLABreachNotification, organizationLabel, realOrganizations, type SLABreach } from "./slaMonitoringService";

const org = (id: number, name: string, isDemo: boolean, code: string | null = null) =>
  ({ id, name, isDemo, code });

describe("when deciding which organisations SLA alerts cover", () => {
  const ORGS = [
    org(1, "Globus Bank Nigeria (Demo)", true),
    org(30001, "BrightGoods Nigeria Ltd (Demo)", true, "BRIGHTGOODS_DEMO"),
    org(60001, "ReconcileAI Dev Store", true, "SL_RECONCILEAI_DEV"),
    org(30002, "Infinity AI Africa Limited", false, OPERATOR_ORG_CODE),
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

  it("should exclude the platform operator's own organisation", () => {
    // An SLA is a promise to a customer, and Infinity AI has none with itself,
    // so a breach there is a breach of nothing. It reached the owner as a real
    // alert: a demo seed run by a super admin filed 66 FMCG exceptions against
    // Infinity AI, and the 24-hour timer emailed "CRITICAL — 6 exceptions
    // breached" naming that organisation as the affected client.
    const real = realOrganizations(ORGS);
    expect(real.has(30002)).toBe(false);
    expect([...real.values()]).not.toContain("Infinity AI Africa Limited");
  });

  it("should exclude the operator even though it is not flagged as demo", () => {
    // The two conditions are separate, and only one of them is true here.
    // Infinity AI is genuinely not a demo tenant, so isDemo cannot carry this —
    // and marking it demo to make the alert stop would be a lie that quietly
    // changes every other rule reading that flag.
    const operator = org(30002, "Infinity AI Africa Limited", false, OPERATOR_ORG_CODE);
    expect(operator.isDemo).toBe(false);
    expect(realOrganizations([operator]).size).toBe(0);
  });

  it("should alert on nobody when the operator is the only non-demo org", () => {
    // Today's actual state, and why any stray row on that org pages the owner.
    const todaysOrgs = ORGS.filter((o) => o.isDemo || o.code === OPERATOR_ORG_CODE);
    expect(realOrganizations(todaysOrgs).size).toBe(0);
  });

  it("should keep monitoring a customer whose segment was set to super_admin", () => {
    // The hazard in keying this on segment: `superAdmin.updateOrganizationSegment`
    // can retype ANY organisation, so one mis-set field would silently drop a
    // paying client out of SLA monitoring and their real breaches would go
    // unreported — worse than the false alert this exclusion exists to stop,
    // because nothing on screen would say so. Identity is the org CODE, so the
    // segment can be whatever it likes.
    const miscategorised = { id: 70003, name: "Taj Bank Limited", isDemo: false, code: "TAJ_BANK" };
    expect(realOrganizations([miscategorised]).get(70003)).toBe("Taj Bank Limited");
  });

  it("should exclude the operator by code even if its segment changes", () => {
    // The same mutability, pointed the other way: retyping Infinity AI does not
    // turn it into a client.
    const operator = { id: 30002, name: "Infinity AI Africa Limited", isDemo: false, code: OPERATOR_ORG_CODE };
    expect(realOrganizations([operator]).size).toBe(0);
  });

  it("should still cover a real client that happens to be alongside the operator", () => {
    // The exclusion must not become "stop alerting". A paying tenant is exactly
    // who this monitor exists for.
    const real = realOrganizations([
      org(30002, "Infinity AI Africa Limited", false, OPERATOR_ORG_CODE),
      org(70001, "TAJBank Limited", false),
    ]);
    expect(real.get(70001)).toBe("TAJBank Limited");
    expect(real.size).toBe(1);
  });
});

describe("when demo data is seeded", () => {
  const SEED = fs.readFileSync(path.join(__dirname, "demoSeedEngine.ts"), "utf8");
  const FINSERV = fs.readFileSync(path.join(__dirname, "demoSeedFinServ.ts"), "utf8");

  it("should refuse to write into an organisation that is not a demo tenant", () => {
    // The cause, not the symptom. The seed runs with whatever organisation the
    // CALLER is in, so a super admin running it wrote 2,640 transactions, 66
    // exceptions and 10 channels into Infinity AI's own org.
    expect(SEED).toMatch(/async function assertDemoTenant/);
    expect(SEED).toMatch(/if \(!org\.isDemo\)/);
  });

  it("should guard every seed entry point, not just the one that failed", () => {
    // Guarding one door and leaving its sibling open is how this class recurs.
    const fmcg = SEED.slice(SEED.indexOf("export async function seedFmcgDemoData"), SEED.indexOf("export async function seedFinservDemoData"));
    const finserv = SEED.slice(SEED.indexOf("export async function seedFinservDemoData"));
    expect(fmcg).toMatch(/await assertDemoTenant\(db, orgId\)/);
    expect(finserv).toMatch(/await assertDemoTenant\(db, orgId\)/);
    expect(FINSERV).toMatch(/is not a demo tenant \(isDemo = 0\)/);
  });

  it("should refuse when the organisation cannot be read at all", () => {
    // "Cannot confirm this is a demo tenant" has to mean no — the same rule that
    // keeps org-less callers out of tenant-scoped writes elsewhere.
    expect(SEED).toMatch(/does not exist/);
    expect(FINSERV).toMatch(/does not exist/);
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

describe("when the alert names an organisation", () => {
  it("should add the code and onboarding channel, so two tenants sharing a name can be told apart", () => {
    // The incident: the Shopify app on our own development store provisioned a
    // second "ReconcileAI Dev Store" (2026-10-16). The alert named only that,
    // and the tenant everyone knew by the name is a flagged demo.
    expect(organizationLabel({ name: "ReconcileAI Dev Store", code: "SHP_8A95F8DFB46562", onboardingChannel: "shopify_public_app" }))
      .toBe("ReconcileAI Dev Store (SHP_8A95F8DFB46562 · shopify_public_app)");
  });

  it("should fall back to the name when there is nothing else to show", () => {
    expect(organizationLabel({ name: "TAJBank Limited", code: null, onboardingChannel: "  " })).toBe("TAJBank Limited");
  });
});

describe("when the alert email is written", () => {
  const breach = (overrides: Partial<SLABreach> = {}): SLABreach => ({
    exceptionId: 930001,
    organizationId: 180001,
    organizationLabel: "ReconcileAI Dev Store (SHP_8A95F8DFB46562 · shopify_public_app)",
    hoursOpen: 21.6,
    severity: "warning",
    ...overrides,
  });
  const APP = "https://www.reconcileaiafrica.com/";

  it("should name the mechanism rather than assert exclusion happened", () => {
    // The old footer promised "Demo data exceptions are excluded from this
    // alert" while the alert was made almost entirely OF demo data. A promise
    // the reader cannot check is worse than none.
    const { content } = formatSLABreachNotification([breach()], APP);
    expect(content).not.toContain("Demo data exceptions are excluded from this alert.");
    expect(content).toContain("(organizations.isDemo) are excluded");
  });

  it("should attribute every breach to the exact tenant, not only its name", () => {
    const { content } = formatSLABreachNotification([breach()], APP);
    expect(content).toContain("ReconcileAI Dev Store (SHP_8A95F8DFB46562 · shopify_public_app) · Exception #930001");
  });

  it("should count two same-named organisations separately", () => {
    // Keyed by name, these two breaches were added into one line, under a
    // name that matched neither tenant's identity.
    const { content } = formatSLABreachNotification([
      breach({ organizationId: 180001, organizationLabel: "ReconcileAI Dev Store (SHP_1 · shopify_public_app)", severity: "warning" }),
      breach({ exceptionId: 2, organizationId: 60001, organizationLabel: "ReconcileAI Dev Store (SL_RECONCILEAI_DEV · shopline_app_store)", severity: "critical", hoursOpen: 30 }),
    ], APP);
    expect(content).toContain("ReconcileAI Dev Store (SHP_1 · shopify_public_app) — 0 breached, 1 approaching");
    expect(content).toContain("ReconcileAI Dev Store (SL_RECONCILEAI_DEV · shopline_app_store) — 1 breached, 0 approaching");
  });

  it("should summarise per organisation before listing ids", () => {
    const { content } = formatSLABreachNotification([breach()], APP);
    expect(content.indexOf("By organisation:")).toBeLessThan(content.indexOf("Exception #930001"));
  });

  it("should show the oldest breaches first, not the lowest ids", () => {
    const { content } = formatSLABreachNotification([
      breach({ exceptionId: 1, hoursOpen: 25, severity: "critical" }),
      breach({ exceptionId: 2, hoursOpen: 40, severity: "critical" }),
    ], APP);
    expect(content.indexOf("Exception #2")).toBeLessThan(content.indexOf("Exception #1 "));
  });

  it("should say where to take a test store out of the alert, on the configured origin", () => {
    const { content } = formatSLABreachNotification([breach()], APP);
    expect(content).toContain("mark it as a demo tenant in POC Hub → Reviewer access links (https://www.reconcileaiafrica.com/admin/poc)");
    expect(content).toContain("Never do this for a paying client.");
  });

  it("should still name the page when no origin is configured", () => {
    // Never a guessed or request-supplied host: the path alone still finds it.
    const { content } = formatSLABreachNotification([breach()], "");
    expect(content).toContain("Reviewer access links (/admin/poc)");
  });

  it("should agree the title with the count", () => {
    expect(formatSLABreachNotification([breach()], APP).title).toBe("⚠️ SLA Breach Alert: 1 Exception Requires Attention");
    expect(formatSLABreachNotification([breach(), breach({ exceptionId: 2 })], APP).title)
      .toBe("⚠️ SLA Breach Alert: 2 Exceptions Require Attention");
  });
});
