/**
 * The Daily Control page as rendered, in each state its data hook can report.
 *
 * The defect this pins: an error, or a cleared date, used to replace the whole
 * page with a message, removing the date picker and refresh button, so the
 * only way to correct the date was to leave the page. The page is rendered to
 * static markup with its data hook replaced, so each state is checked for the
 * controls as well as for its own notice.
 *
 * Lives in client/src/lib because that is the client path vitest collects.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DailyControlReadiness } from "@/hooks/useDailyControlReadiness";

const hook = vi.hoisted(() => ({ state: null as unknown }));

vi.mock("wouter", () => ({ useLocation: () => ["/daily-control", () => {}] }));
vi.mock("@/contexts/PortalContext", () => ({ usePortalContext: () => ({ viewAsOrg: null }) }));
vi.mock("@/hooks/useDailyControlReadiness", () => ({ useDailyControlReadiness: () => hook.state }));
vi.mock("@/lib/trpc", () => ({
  trpc: { reconciliation: { createGovernedDailyControl: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) } } },
}));

import DailyControl from "@/pages/DailyControl";

type Assessment = NonNullable<DailyControlReadiness["assessment"]>;

function render(state: Partial<DailyControlReadiness>): string {
  hook.state = {
    view: "assessed",
    assessment: undefined,
    errorMessage: null,
    isFetching: false,
    refetch: () => {},
    ...state,
  } satisfies DailyControlReadiness;
  return renderToStaticMarkup(createElement(DailyControl));
}

function assessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    status: "awaiting_sources",
    canReconcile: false,
    mayPublishMatchRate: false,
    reasons: [],
    sourceAssessments: [],
    organizationId: 7,
    controlPeriod: "2026-10-10",
    evaluatedAt: new Date("2026-10-10T08:00:00Z"),
    persistenceReasons: [],
    sourceContractCount: 0,
    batchManifestCount: 0,
    reconciliationPolicyVersions: [],
    sourceContractBindings: [],
    governedAdmission: { admissible: false, reasons: ["evidence_not_ready"] },
    ...overrides,
  } as Assessment;
}

/** The two controls the user needs to pick another day and ask again. */
function expectPeriodControls(html: string): void {
  expect(html).toContain('aria-label="Control period"');
  expect(html).toContain("Refresh readiness");
}

describe("when the readiness request fails", () => {
  it("should keep the date picker and refresh button, and show the error beside them", () => {
    const html = render({ view: "error", errorMessage: "You cannot view this organisation." });

    expectPeriodControls(html);
    expect(html).toContain("You cannot view this organisation.");
  });
});

describe("when the date picker is cleared", () => {
  it("should keep the controls, ask for a complete date, and not offer a refresh that would be refused", () => {
    const html = render({ view: "invalid_period" });

    expectPeriodControls(html);
    expect(html).toContain("Enter a complete calendar date");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Refresh readiness/s);
  });
});

describe("when readiness is still loading", () => {
  it("should keep the controls while it loads", () => {
    const html = render({ view: "loading" });

    expectPeriodControls(html);
    expect(html).toContain("Loading daily-control");
  });
});

describe("when an assessment has control-level reasons", () => {
  it("should show the control-level issues card", () => {
    const html = render({ assessment: assessment({ reasons: ["no_required_sources"] }) });

    expect(html).toContain("Control-level evidence");
    expect(html).toContain("No Required Sources");
  });
});

describe("when an assessment has no control-level reasons", () => {
  it("should leave the issues card out entirely", () => {
    const html = render({ assessment: assessment() });

    expect(html).toContain("Awaiting source evidence");
    expect(html).not.toContain("Control-level evidence");
  });
});

/** The Start button's opening tag, to read whether it is disabled. */
function startButton(html: string): string {
  const match = /<button[^>]*>(?:(?!<\/button>).)*Start governed control/s.exec(html);
  if (!match) throw new Error("no Start button rendered");
  return match[0].slice(0, match[0].indexOf(">") + 1);
}

describe("when the evidence is ready but a governed run would be refused", () => {
  it("should keep Start disabled and say why, instead of letting every click fail", () => {
    const html = render({
      assessment: assessment({
        status: "ready_to_reconcile",
        canReconcile: true,
        governedAdmission: { admissible: false, reasons: ["internal_register_source_count"] },
      }),
    });

    expect(startButton(html)).toContain('disabled=""');
    expect(html).toContain("Start is withheld");
    expect(html).toContain("Internal Register Source Count");
  });
});

describe("when a governed run would be admitted", () => {
  it("should enable Start, with no withheld notice", () => {
    const html = render({
      assessment: assessment({
        status: "ready_to_reconcile",
        canReconcile: true,
        governedAdmission: { admissible: true, reasons: [] },
      }),
    });

    // The attribute, not the word: the button's classes contain "disabled:".
    expect(startButton(html)).not.toContain('disabled=""');
    expect(html).not.toContain("Start is withheld");
  });
});

describe("when the evidence is not ready", () => {
  it("should keep Start disabled, leaving the explanation to the status banner", () => {
    const html = render({ assessment: assessment() });

    expect(startButton(html)).toContain('disabled=""');
    expect(html).not.toContain("Start is withheld");
  });
});
