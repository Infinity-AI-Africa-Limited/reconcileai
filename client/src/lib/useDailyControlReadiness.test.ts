/**
 * The Daily Control hook decides when to ask the API. A cleared or half-typed
 * date must never be sent: the API refuses it, and before this the page then
 * showed an error with no way back. The tRPC client is replaced, so this reads
 * exactly what the hook asks for.
 *
 * Lives in client/src/lib because that is the client path vitest collects.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const trpcCall = vi.hoisted(() => ({
  input: null as unknown,
  options: null as null | { enabled?: boolean; retry?: unknown },
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    controlEvidence: {
      assessReadiness: {
        useQuery: (input: unknown, options: { enabled?: boolean }) => {
          trpcCall.input = input;
          trpcCall.options = options;
          return { data: undefined, error: null, isLoading: false, isFetching: false, refetch: async () => ({}) };
        },
      },
    },
  },
}));

import { useDailyControlReadiness, type DailyControlReadiness } from "@/hooks/useDailyControlReadiness";

function run(controlPeriod: string): DailyControlReadiness {
  let result: DailyControlReadiness | null = null;
  function Probe() {
    result = useDailyControlReadiness(controlPeriod, 7);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!result) throw new Error("the hook did not run");
  return result;
}

describe("when the control period is not a real calendar day", () => {
  it.each([
    ["cleared", ""],
    ["half-typed", "2026-10-"],
    ["a day that does not exist", "2026-02-30"],
  ])("should hold the query back for a %s date, and say why", (_label, period) => {
    const readiness = run(period);

    expect(trpcCall.options?.enabled).toBe(false);
    expect(readiness.view).toBe("invalid_period");
  });
});

describe("when the control period is a real calendar day", () => {
  it("should ask for that day, for the organisation on screen, without retrying a refusal", () => {
    const readiness = run("2026-10-10");

    expect(trpcCall.options).toMatchObject({ enabled: true, retry: false });
    expect(trpcCall.input).toEqual({ organizationId: 7, controlPeriod: "2026-10-10" });
    expect(readiness.view).toBe("assessed");
  });
});
