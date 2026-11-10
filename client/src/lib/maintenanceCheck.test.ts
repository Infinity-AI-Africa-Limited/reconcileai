import { describe, expect, it } from "vitest";
import {
  assessReadings,
  describeError,
  describeNotCollected,
  describeReadings,
  describeSurface,
  formatAge,
  formatCount,
  presentVerdict,
  type Reading,
  type WorkloadVerdict,
} from "./maintenanceCheck";
import { DB_SURFACES, NOT_COLLECTED } from "../../../server/maintenance/workloadCatalogue";
import { ERROR_CODES } from "../../../server/maintenance/workloadCheck";

const at = (seconds: number, verdict: WorkloadVerdict = "zero_observed_not_proof"): Reading => ({
  checkedAt: new Date(Date.UTC(2026, 10, 10, 12, 0, 0) + seconds * 1000).toISOString(),
  verdict,
});
const NOW = Date.UTC(2026, 10, 10, 12, 10, 0);

describe("when a verdict is shown", () => {
  it("should never call a quiet reading permission", () => {
    const quiet = presentVerdict("zero_observed_not_proof");
    expect(quiet.title).toBe("Nothing observed");
    expect(quiet.message).toContain("not permission");
    expect(quiet.title + quiet.message).not.toMatch(/\bsafe\b|\bclear to\b|\bgo ahead\b/i);
  });

  it("should tell work in progress and incomplete readings apart", () => {
    expect(presentVerdict("no_go_unfinished_work").tone).toBe("critical");
    expect(presentVerdict("no_go_incomplete_evidence").tone).toBe("warning");
  });
});

describe("when a count or an age is shown", () => {
  it("should show an unread count as unknown, never as zero", () => {
    expect(formatCount(null)).toBe("Unknown");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(12345)).toBe("12,345");
  });

  it.each([
    [null, "—"],
    [45, "45 s"],
    [125, "2 min"],
    [3 * 3600 + 5 * 60, "3 h 5 min"],
    [3 * 86_400, "3 days"],
  ])("should show an age of %j seconds as %s", (seconds, text) => {
    expect(formatAge(seconds)).toBe(text);
  });
});

describe("when the server's fixed codes are shown", () => {
  it("should have plain words for every error code the check can report", () => {
    for (const code of ERROR_CODES) expect(describeError(code), code).not.toBe("An unrecognised problem was reported.");
  });

  it("should have plain words for every gap the check declares", () => {
    for (const code of NOT_COLLECTED) expect(describeNotCollected(code), code).not.toBe(code.replace(/_/g, " "));
  });

  it("should name every surface the check counts", () => {
    for (const s of DB_SURFACES) expect(describeSurface(s.id), s.id).not.toBe(s.id);
  });
});

describe("when several readings are taken", () => {
  it("should ask for readings when there are none", () => {
    expect(assessReadings([], NOW)).toEqual({ kind: "none" });
  });

  it("should ask for three, each a minute after the last", () => {
    expect(assessReadings([at(0)], NOW)).toEqual({ kind: "need_more", remaining: 2 });
    expect(describeReadings({ kind: "need_more", remaining: 1 })).toContain("1 more reading,");
  });

  it("should show three quiet readings a minute apart as quiet, and still not as permission", () => {
    const status = assessReadings([at(0), at(60), at(125)], NOW);
    expect(status).toEqual({ kind: "quiet", spanMs: 125_000 });
    expect(describeReadings(status)).toContain("not permission");
  });

  it("should not count readings taken less than a minute apart", () => {
    expect(assessReadings([at(0), at(30), at(90)], Date.UTC(2026, 10, 10, 12, 2, 0))).toEqual({ kind: "too_close", waitMs: 30_000 });
  });

  it("should judge only the latest three, so an old problem does not stick", () => {
    expect(assessReadings([at(0, "no_go_unfinished_work"), at(60), at(120), at(180)], NOW)).toMatchObject({ kind: "quiet" });
  });

  it("should let any work or gap in the latest three outrank quiet ones", () => {
    expect(assessReadings([at(0), at(60, "no_go_incomplete_evidence"), at(120)], NOW)).toEqual({ kind: "incomplete" });
    expect(assessReadings([at(0, "no_go_incomplete_evidence"), at(60, "no_go_unfinished_work"), at(120)], NOW)).toEqual({
      kind: "work_in_progress",
    });
  });
});
