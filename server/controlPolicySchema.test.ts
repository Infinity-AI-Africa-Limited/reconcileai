/**
 * What a control policy may contain, and how it is named.
 *
 * Greptile #191: tRPC's superjson transformer restores Dates (and Maps, Sets,
 * BigInts…), and the digest's canonical form read every Date as `{}`, so two
 * definitions differing only in a date shared one digest, while the column
 * stored each as its ISO string. A digest that does not identify what was
 * approved is worse than none. These pin that only plain JSON is admitted.
 */
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import {
  assertControlPolicyWriter,
  controlPolicyScopeInput,
  createControlPolicyInput,
  POLICY_DEFINITION_MAX_DEPTH,
  retireControlPolicyInput,
  toPolicyDefinition,
} from "./controlPolicySchema";

const draft = {
  policyType: "reconciliation" as const,
  policyKey: "settlement-to-register",
  version: 1,
  displayName: "Daily settlement to register",
  description: "Exact daily settlement control.",
  definition: { amountTolerance: "0.00", dateWindowDays: 0 },
  effectiveAt: "2026-10-13T00:00:00.000Z",
};

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let level = 0; level < depth; level++) value = { next: value };
  return value;
}

describe("when a definition is plain JSON", () => {
  it("should be accepted as an equal copy, not the caller's object", () => {
    const definition = {
      thresholds: { amount: "0.00", days: 0, ratio: 0.25 },
      statuses: ["posted", "pending", null, true],
      "Naïve key ✓": "unicode is fine",
    };
    const checked = toPolicyDefinition(definition);

    expect(checked).toEqual({ ok: true, value: definition });
    expect(checked.ok && checked.value).not.toBe(definition);
  });

  it("should accept nesting up to the depth limit", () => {
    expect(toPolicyDefinition(nested(POLICY_DEFINITION_MAX_DEPTH)).ok).toBe(true);
  });
});

describe("when a definition holds a value JSON cannot carry faithfully", () => {
  it.each<[string, unknown]>([
    ["a Date", { cutoff: new Date("2026-10-13T00:00:00.000Z") }],
    ["a Date nested in an array", { windows: [{ from: new Date(0) }] }],
    ["a Map", { lookup: new Map([["a", 1]]) }],
    ["a Set", { statuses: new Set(["posted"]) }],
    ["a BigInt", { limit: BigInt(10) }],
    ["undefined", { missing: undefined }],
    ["NaN", { ratio: Number.NaN }],
    ["Infinity", { ratio: Number.POSITIVE_INFINITY }],
    ["a class instance", { error: new Error("x") }],
    ["a RegExp", { pattern: /ref-\d+/ }],
    ["a function", { compute: () => 1 }],
    ["an array hole", { columns: [1, , 3] }],
    ["a lone surrogate", { label: "\uD800" }],
  ])("should refuse %s rather than hash it as something else", (_label, definition) => {
    const checked = toPolicyDefinition(definition);
    expect(checked.ok).toBe(false);
  });

  it("should name the path and the offending type, so the caller can fix it", () => {
    const checked = toPolicyDefinition({ windows: [{ from: new Date(0) }] });
    expect(checked).toEqual({ ok: false, reason: expect.stringContaining("definition.windows[0].from is Date") });
  });
});

describe("when a definition's shape is not a bounded JSON object", () => {
  it.each<[string, unknown]>([
    ["an array", ["a", "b"]],
    ["a string", "settlement"],
    ["null", null],
    ["missing", undefined],
  ])("should refuse %s at the top level", (_label, definition) => {
    expect(toPolicyDefinition(definition)).toEqual({ ok: false, reason: "Policy definition must be a JSON object." });
  });

  it.each<[string, unknown]>([
    ["an empty key", { "": 1 }],
    ["a key with surrounding spaces", { " amount": 1 }],
    ["a key over 120 characters", { ["k".repeat(121)]: 1 }],
    ["a __proto__ key", JSON.parse('{"__proto__": {"polluted": true}}')],
    ["a nested __proto__ key", JSON.parse('{"rules": {"__proto__": 1}}')],
  ])("should refuse %s, which would be dropped or merged rather than stored", (_label, definition) => {
    expect(toPolicyDefinition(definition).ok).toBe(false);
  });

  it("should refuse nesting deeper than the limit before it can exhaust the stack", () => {
    expect(toPolicyDefinition(nested(POLICY_DEFINITION_MAX_DEPTH + 1))).toEqual({
      ok: false,
      reason: expect.stringMatching(/nested more than/),
    });
    // Far beyond any stack: refused by the bound, not by a RangeError.
    expect(toPolicyDefinition(nested(50_000)).ok).toBe(false);
  });

  it("should refuse a definition over 50 KB, counted in UTF-8 bytes", () => {
    expect(toPolicyDefinition({ blob: "x".repeat(49_000) }).ok).toBe(true);
    // 17,000 three-byte characters: 51 KB of UTF-8 in 17,000 UTF-16 units.
    expect(toPolicyDefinition({ blob: "€".repeat(17_000) })).toEqual({
      ok: false,
      reason: expect.stringMatching(/at most 50 KB/),
    });
  });
});

describe("when a draft is parsed from a request", () => {
  it("should hand the store the validated copy", () => {
    const parsed = createControlPolicyInput.parse(draft);
    expect(parsed.definition).toEqual(draft.definition);
    expect(parsed.effectiveAt).toEqual(new Date(draft.effectiveAt));
  });

  it("should refuse a Date inside the definition as a bad request", () => {
    const result = createControlPolicyInput.safeParse({ ...draft, definition: { cutoff: new Date(0) } });
    expect(result.success).toBe(false);
  });

  it.each(["Settlement-To-Register", "settlement to register", "-settlement", "settlement-", "a:b", "x".repeat(101), ""])(
    "should refuse the policy key %j, which the collation could not compare as written",
    policyKey => {
      expect(createControlPolicyInput.safeParse({ ...draft, policyKey }).success).toBe(false);
    }
  );

  it.each(["settlement-to-register", "settlement_csv.v1", "a", "x".repeat(100)])(
    "should accept the policy key %j",
    policyKey => {
      expect(createControlPolicyInput.safeParse({ ...draft, policyKey }).success).toBe(true);
    }
  );
});

describe("when a retirement is requested", () => {
  it("should take no caller-supplied date: retirement is recorded when it happens", () => {
    const withDate = retireControlPolicyInput.safeParse({
      policyId: 7,
      retirementReference: "CAB-1",
      retiredAt: "2026-11-01T00:00:00.000Z",
    });
    expect(withDate.success).toBe(false);
    expect(retireControlPolicyInput.safeParse({ policyId: 7, retirementReference: "CAB-1" }).success).toBe(true);
  });
});

describe("when the policy history is paged", () => {
  it("should accept the cursor as an ISO string or a Date, and a version filter", () => {
    const fromString = controlPolicyScopeInput.parse({ cursor: { effectiveAt: "2026-10-13T00:00:00.000Z", id: 9 }, version: 3 });
    const fromDate = controlPolicyScopeInput.parse({ cursor: { effectiveAt: new Date("2026-10-13T00:00:00.000Z"), id: 9 } });
    expect(fromString.cursor).toEqual({ effectiveAt: new Date("2026-10-13T00:00:00.000Z"), id: 9 });
    expect(fromDate.cursor).toEqual(fromString.cursor);
    expect(fromString.version).toBe(3);
  });
});

describe("when someone other than an administrator or operations owner writes", () => {
  const actor = { id: 1, role: "operations", organizationId: 42, isGuest: false };

  it.each(["cfo", "compliance", "user", "reviewer"])("should refuse the %s role", role => {
    expect(() => assertControlPolicyWriter({ ...actor, role })).toThrow(TRPCError);
  });

  it("should refuse a guest whatever the role", () => {
    expect(() => assertControlPolicyWriter({ ...actor, role: "admin", isGuest: true })).toThrow(TRPCError);
  });

  it.each(["super_admin", "admin", "operations"])("should admit the %s role", role => {
    expect(() => assertControlPolicyWriter({ ...actor, role })).not.toThrow();
  });
});
