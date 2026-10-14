/**
 * Drafts filed under the case they were written for. The defect they prevent:
 * a late-resolution reason typed for case A, the dialog dismissed, case B
 * opened — and A's reason sitting in B's form, one click from becoming B's
 * permanent closure evidence.
 */
import { describe, expect, it } from "vitest";
import { clearIfStill } from "./exceptionWorkflowPresentation";
import { readKeyedDraft, writeKeyedDraft, type KeyedDrafts } from "./keyedDraft";

const A = "5:91";
const B = "6:92";

describe("when a draft written for one case is read under another", () => {
  it("should read as empty for the other case", () => {
    const drafts = writeKeyedDraft({}, A, "Counterparty answered late");
    expect(readKeyedDraft(drafts, B)).toBe("");
  });

  it("should still be there when the operator returns to the case it was written for", () => {
    let drafts: KeyedDrafts = writeKeyedDraft({}, A, "Counterparty answered late");
    drafts = writeKeyedDraft(drafts, B, "Bank statement arrived late");
    expect(readKeyedDraft(drafts, A)).toBe("Counterparty answered late");
    expect(readKeyedDraft(drafts, B)).toBe("Bank statement arrived late");
  });
});

describe("when an earlier case's request finishes after the operator moved on", () => {
  it("should clear that case's draft and leave the current case's draft alone", () => {
    let drafts: KeyedDrafts = writeKeyedDraft({}, A, "Reason for A");
    drafts = writeKeyedDraft(drafts, B, "Reason for B");

    // The setter A's close captured, firing once A's close succeeds.
    drafts = writeKeyedDraft(drafts, A, clearIfStill("Reason for A"));

    expect(readKeyedDraft(drafts, A)).toBe("");
    expect(readKeyedDraft(drafts, B)).toBe("Reason for B");
  });

  it("should give an updater only its own case's text", () => {
    const drafts = writeKeyedDraft(writeKeyedDraft({}, B, "Reason for B"), A, current => `${current}|appended`);
    expect(readKeyedDraft(drafts, A)).toBe("|appended");
  });
});

describe("when a draft is emptied", () => {
  it("should drop it, keeping only text still being written", () => {
    const drafts = writeKeyedDraft(writeKeyedDraft({}, A, "x"), A, "");
    expect(drafts).toEqual({});
  });
});
