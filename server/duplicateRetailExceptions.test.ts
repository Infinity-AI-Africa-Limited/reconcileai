/**
 * Which copies of a duplicated retail exception are dismissed, and which are
 * kept or left for a person. The planner is pure; the database behaviour is in
 * duplicateRetailExceptions.db.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  type DuplicateCandidate,
  duplicateNote,
  planDuplicateGroups,
  summariseTenant,
} from "./duplicateRetailExceptions";

const ORG = 42;
const TXN = 7;
const CATEGORY = "retail_settlement_shortfall";
const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-11-04T12:00:00.000Z");

function copy(id: number, overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    id,
    organizationId: ORG,
    transactionId: TXN,
    subCategory: CATEGORY,
    status: "open",
    createdAt: new Date(NOW.getTime() - (10 - id) * DAY),
    touched: false,
    dismissedAsDuplicate: false,
    ...overrides,
  };
}

describe("when one case was filed several times and nobody has worked on it", () => {
  it("should keep the oldest copy and dismiss every other", () => {
    expect(planDuplicateGroups([copy(3), copy(1), copy(2)])).toEqual([
      {
        organizationId: ORG,
        transactionId: TXN,
        subCategory: CATEGORY,
        keeperId: 1,
        close: [2, 3],
        leftForPerson: [],
        decidedBesideOpen: false,
      },
    ]);
  });
});

describe("when someone has worked on one of the copies", () => {
  it("should keep the copy that carries work, even if it is not the oldest", () => {
    const [plan] = planDuplicateGroups([copy(1), copy(2, { touched: true }), copy(3)]);
    expect(plan.keeperId).toBe(2);
    expect(plan.close).toEqual([1, 3]);
  });

  it("should prefer an escalated copy to one in review, and one in review to an open one", () => {
    const [plan] = planDuplicateGroups([copy(1), copy(2, { status: "in_review" }), copy(3, { status: "escalated" })]);
    expect(plan.keeperId).toBe(3);
    expect(plan.close).toEqual([1]);
    expect(plan.leftForPerson).toEqual([2]);
  });

  it("should leave every other worked-on copy for a person, never dismiss it", () => {
    const [plan] = planDuplicateGroups([copy(1, { touched: true }), copy(2, { touched: true }), copy(3)]);
    expect(plan.keeperId).toBe(1);
    expect(plan.close).toEqual([3]);
    expect(plan.leftForPerson).toEqual([2]);
  });
});

describe("when a person has decided one copy", () => {
  it("should dismiss nothing beside a single open copy, and report the pair", () => {
    // A settlement file may raise a case again after a person closed it, and
    // nothing on the row says which path filed it.
    const [plan] = planDuplicateGroups([copy(1, { status: "resolved", touched: true }), copy(2)]);
    expect(plan).toMatchObject({ keeperId: 2, close: [], leftForPerson: [], decidedBesideOpen: true });
  });

  it("should still dismiss open copies that duplicate each other", () => {
    const [plan] = planDuplicateGroups([copy(1, { status: "dismissed", touched: true }), copy(2), copy(3)]);
    expect(plan).toMatchObject({ keeperId: 2, close: [3], decidedBesideOpen: true });
  });

  it("should do nothing when every copy is decided", () => {
    const [plan] = planDuplicateGroups([copy(1, { status: "resolved" }), copy(2, { status: "dismissed" })]);
    expect(plan).toMatchObject({ keeperId: null, close: [], leftForPerson: [], decidedBesideOpen: false });
  });
});

describe("when this maintenance has already dismissed copies", () => {
  it("should count them as neither a decision nor a copy still to handle", () => {
    // Without this, a run after a commit reported its own dismissals as
    // "a decided copy beside an open one".
    expect(
      planDuplicateGroups([
        copy(1),
        copy(2, { status: "dismissed", touched: true, dismissedAsDuplicate: true }),
        copy(3, { status: "dismissed", touched: true, dismissedAsDuplicate: true }),
      ]),
    ).toEqual([]);
  });
});

describe("when exceptions only look alike", () => {
  it("should not group copies of different tenants, transactions or categories", () => {
    expect(
      planDuplicateGroups([
        copy(1),
        copy(2, { organizationId: ORG + 1 }),
        copy(3, { transactionId: TXN + 1 }),
        copy(4, { subCategory: "retail_refund_not_reflected" }),
      ]),
    ).toEqual([]);
  });
});

describe("when a tenant's duplicates are summarised", () => {
  it("should count the groups, the copies to dismiss, and when the newest of them was filed", () => {
    const candidates = [
      copy(1),
      copy(2, { createdAt: new Date(NOW.getTime() - 3 * DAY) }),
      copy(3, { createdAt: new Date(NOW.getTime() - 2 * DAY) }),
      copy(4, { transactionId: TXN + 1, status: "resolved" }),
      copy(5, { transactionId: TXN + 1, touched: true }),
      copy(6, { transactionId: TXN + 2, status: "in_review" }),
      copy(7, { transactionId: TXN + 2, touched: true }),
    ];
    const plans = planDuplicateGroups(candidates);

    expect(summariseTenant(ORG, candidates, plans)).toEqual({
      organizationId: ORG,
      groups: 3,
      toClose: 2,
      needPerson: 1,
      decidedBesideOpen: 1,
      newestToClose: new Date(NOW.getTime() - 2 * DAY),
    });
  });
});

describe("when a dismissed copy's note is written", () => {
  it("should name the copy kept, the fix, and how to undo it", () => {
    const note = duplicateNote(1234, NOW);
    expect(note).toContain("Duplicate of exception #1234");
    expect(note).toContain("#209");
    expect(note).toContain("2026-11-04");
    expect(note).toContain("reopen it if this is wrong");
  });
});
