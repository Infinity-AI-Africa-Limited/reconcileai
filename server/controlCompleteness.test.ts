import { describe, expect, it } from "vitest";
import {
  assessControlRunReadiness,
  assessSourceReadiness,
  type ReceivedSourceManifest,
  type RequiredSourceManifest,
} from "./controlCompleteness";

const NOW = new Date("2026-10-09T17:00:00.000Z");
const CUTOFF = new Date("2026-10-09T16:00:00.000Z");
const LATER_CUTOFF = new Date("2026-10-09T18:00:00.000Z");

function received(
  overrides: Partial<ReceivedSourceManifest> = {}
): ReceivedSourceManifest {
  return {
    batchId: "batch-settlement-20261009",
    receivedAt: new Date("2026-10-09T15:55:00.000Z"),
    sourceContractVersion: "settlement-contract-v1",
    mappingVersion: "settlement-map-v1",
    schemaState: "accepted",
    invalidRowCount: 0,
    duplicateDelivery: "none",
    recordCount: 2,
    monetaryTotal: "1250.10",
    currency: "NGN",
    ...overrides,
  };
}

function source(
  overrides: Partial<RequiredSourceManifest> = {}
): RequiredSourceManifest {
  return {
    sourceKey: "processor_settlement",
    role: "settlement",
    required: true,
    cutoffAt: CUTOFF,
    controlTotalRequired: true,
    expected: { recordCount: 2, monetaryTotal: "1250.1", currency: "NGN" },
    received: received(),
    ...overrides,
  };
}

function register(
  overrides: Partial<RequiredSourceManifest> = {}
): RequiredSourceManifest {
  return source({
    sourceKey: "internal_settlement_register",
    role: "internal_register",
    received: received({
      batchId: "batch-register-20261009",
      sourceContractVersion: "register-contract-v2",
      mappingVersion: "register-map-v3",
    }),
    ...overrides,
  });
}

/** A manifest as storage might return it, whatever its declared type says. */
function loaded(fields: Record<string, unknown>): ReceivedSourceManifest {
  return { ...received(), ...fields } as unknown as ReceivedSourceManifest;
}

describe("when every required source is complete and valid", () => {
  it("should permit reconciliation and match-rate publication", () => {
    const result = assessControlRunReadiness([source(), register()], NOW);

    expect(result.status).toBe("ready_to_reconcile");
    expect(result.canReconcile).toBe(true);
    expect(result.mayPublishMatchRate).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.sourceAssessments.map(a => a.status)).toEqual([
      "ready",
      "ready",
    ]);
  });

  it("should accept a duplicate delivery that was safely deduplicated, and say so", () => {
    const result = assessControlRunReadiness(
      [source({ received: received({ duplicateDelivery: "deduplicated" }) })],
      NOW
    );

    expect(result.status).toBe("ready_to_reconcile");
    expect(result.sourceAssessments[0].warnings).toEqual([
      "duplicate_delivery_deduplicated",
    ]);
  });

  it("should accept evidence received exactly at the evaluation time", () => {
    const result = assessControlRunReadiness(
      [
        source({
          cutoffAt: LATER_CUTOFF,
          received: received({ receivedAt: new Date(NOW) }),
        }),
      ],
      NOW
    );

    expect(result.status).toBe("ready_to_reconcile");
  });
});

describe("when a required source has not arrived", () => {
  it("should await it while its cut-off is still ahead, without calling the control complete", () => {
    const result = assessControlRunReadiness(
      [source({ cutoffAt: LATER_CUTOFF, received: undefined })],
      NOW
    );

    expect(result.status).toBe("awaiting_sources");
    expect(result.canReconcile).toBe(false);
    expect(result.mayPublishMatchRate).toBe(false);
    expect(result.sourceAssessments[0]).toMatchObject({
      status: "awaiting_source",
      reasons: ["source_not_received"],
    });
  });

  it("should still await it at the cut-off itself", () => {
    const result = assessControlRunReadiness(
      [source({ cutoffAt: new Date(NOW), received: undefined })],
      NOW
    );

    expect(result.status).toBe("awaiting_sources");
  });

  it("should call the run incomplete once the cut-off has passed", () => {
    const result = assessControlRunReadiness(
      [source({ received: undefined })],
      NOW
    );

    expect(result.status).toBe("incomplete");
    expect(result.mayPublishMatchRate).toBe(false);
    expect(result.sourceAssessments[0]).toMatchObject({
      status: "incomplete",
      reasons: ["source_not_received"],
    });
  });

  it("should treat a source with no `required` flag as required", () => {
    // Only an explicit `false` makes a source optional. A manifest loaded
    // without the field must not quietly drop out of the control.
    const unflagged = {
      ...source({ received: undefined }),
      required: undefined,
    } as unknown as RequiredSourceManifest;

    const result = assessControlRunReadiness([register(), unflagged], NOW);

    expect(result.status).toBe("incomplete");
    expect(result.sourceAssessments[1].required).toBe(true);
  });
});

describe("when a required source arrives after its cut-off", () => {
  it("should call the run incomplete", () => {
    const result = assessControlRunReadiness(
      [
        source({
          received: received({
            receivedAt: new Date("2026-10-09T16:00:01.000Z"),
          }),
        }),
      ],
      NOW
    );

    expect(result.status).toBe("incomplete");
    expect(result.mayPublishMatchRate).toBe(false);
    expect(result.sourceAssessments[0].reasons).toEqual([
      "received_after_cutoff",
    ]);
  });
});

describe("when evidence is dated after the evaluation time", () => {
  it("should block the run, even though the cut-off has not passed", () => {
    // Evaluated at 17:00 with an 18:00 cut-off: a 17:30 receipt passes every
    // cut-off check, and only the evaluation time exposes it.
    const result = assessControlRunReadiness(
      [
        source({
          cutoffAt: LATER_CUTOFF,
          received: received({
            receivedAt: new Date("2026-10-09T17:30:00.000Z"),
          }),
        }),
      ],
      NOW
    );

    expect(result).toMatchObject({
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
    });
    expect(result.sourceAssessments[0].reasons).toEqual([
      "received_after_evaluation_time",
    ]);
  });
});

describe("when a source's population does not match its contract totals", () => {
  it("should call the run incomplete rather than reconciled", () => {
    const result = assessControlRunReadiness(
      [
        source({
          received: received({ recordCount: 3, monetaryTotal: "1249.10" }),
        }),
      ],
      NOW
    );

    expect(result.status).toBe("incomplete");
    expect(result.sourceAssessments[0]).toMatchObject({
      status: "incomplete",
      reasons: ["record_count_mismatch", "monetary_total_mismatch"],
    });
  });

  it("should flag a total in another currency instead of comparing the amounts", () => {
    const result = assessControlRunReadiness(
      [source({ received: received({ currency: "USD" }) })],
      NOW
    );

    expect(result.status).toBe("incomplete");
    expect(result.sourceAssessments[0].reasons).toEqual(["currency_mismatch"]);
  });
});

describe("when a source's evidence cannot be trusted", () => {
  it.each<[string, Partial<ReceivedSourceManifest>, string[]]>([
    [
      "a rejected schema with refused rows",
      { schemaState: "rejected", invalidRowCount: 4 },
      ["schema_not_accepted", "invalid_rows_present"],
    ],
    [
      "an unknown schema state",
      { schemaState: "unknown" },
      ["schema_not_accepted"],
    ],
    [
      "a duplicate delivery it could not deduplicate",
      { duplicateDelivery: "rejected" },
      ["duplicate_delivery_rejected"],
    ],
    ["no batch identity", { batchId: "  " }, ["missing_batch_identity"]],
    [
      "no source contract version",
      { sourceContractVersion: "" },
      ["missing_source_contract_version"],
    ],
    ["no mapping version", { mappingVersion: "" }, ["missing_mapping_version"]],
    [
      "a malformed monetary total",
      { monetaryTotal: "1,250.10" },
      ["invalid_control_total"],
    ],
    [
      "an unreadable receipt time",
      { receivedAt: new Date("not a timestamp") },
      ["invalid_received_at"],
    ],
  ])("should block the run for %s", (_label, overrides, reasons) => {
    const result = assessControlRunReadiness(
      [source({ received: received(overrides) })],
      NOW
    );

    expect(result.status).toBe("blocked");
    expect(result.mayPublishMatchRate).toBe(false);
    expect(result.sourceAssessments[0]).toMatchObject({
      status: "blocked",
      reasons,
    });
  });
});

describe("when untrustworthy evidence is ALSO late or short", () => {
  // Every pairing of a blocking defect with a population shortfall. The
  // shortfall must never become the headline: a caller shown `incomplete`
  // would read a delay, not evidence it cannot use.
  const unsafe: Array<[string, Partial<ReceivedSourceManifest>]> = [
    ["rejected schema", { schemaState: "rejected" }],
    ["refused rows", { invalidRowCount: 1 }],
    ["undeduplicated duplicate", { duplicateDelivery: "rejected" }],
    ["missing batch identity", { batchId: "" }],
    ["missing mapping version", { mappingVersion: "" }],
  ];
  const short: Array<[string, Partial<ReceivedSourceManifest>]> = [
    ["late", { receivedAt: new Date("2026-10-09T16:30:00.000Z") }],
    ["count short", { recordCount: 1 }],
    ["wrong currency", { currency: "USD" }],
    ["value short", { monetaryTotal: "1000.00" }],
  ];
  const pairs = unsafe.flatMap(([u, unsafeFields]) =>
    short.map(
      ([s, shortFields]) =>
        [`${u} + ${s}`, { ...unsafeFields, ...shortFields }] as const
    )
  );

  it.each(pairs)("should block the run for %s", (_label, fields) => {
    const result = assessControlRunReadiness(
      [source({ received: received(fields) })],
      NOW
    );

    expect(result.status).toBe("blocked");
    expect(result.sourceAssessments[0].status).toBe("blocked");
    // Both defects are still reported, so the operator sees the whole picture.
    expect(result.sourceAssessments[0].reasons.length).toBeGreaterThanOrEqual(
      2
    );
  });
});

describe("when the source contract is unusable", () => {
  const brokenContracts: Array<
    [string, Partial<RequiredSourceManifest>, string]
  > = [
    [
      "totals not required",
      { controlTotalRequired: false },
      "control_total_not_required",
    ],
    [
      "no expected totals",
      { expected: undefined },
      "missing_expected_control_total",
    ],
    [
      "malformed expected totals",
      {
        expected: {
          recordCount: -1,
          monetaryTotal: "1250.10",
          currency: "NGN",
        },
      },
      "invalid_expected_control_total",
    ],
  ];

  it.each(brokenContracts)(
    "should block a delivered source with %s",
    (_label, contract, reason) => {
      const result = assessControlRunReadiness([source(contract)], NOW);

      expect(result.status).toBe("blocked");
      expect(result.sourceAssessments[0].reasons).toEqual([reason]);
    }
  );

  it.each(brokenContracts)(
    "should block, not await, a source with %s that has not arrived yet",
    (_label, contract, reason) => {
      const result = assessControlRunReadiness(
        [source({ ...contract, cutoffAt: LATER_CUTOFF, received: undefined })],
        NOW
      );

      expect(result.status).toBe("blocked");
      expect(result.sourceAssessments[0].reasons).toEqual([
        reason,
        "source_not_received",
      ]);
    }
  );

  it.each(brokenContracts)(
    "should block, not call incomplete, a source with %s that is overdue",
    (_label, contract, reason) => {
      const result = assessControlRunReadiness(
        [source({ ...contract, received: undefined })],
        NOW
      );

      expect(result.status).toBe("blocked");
      expect(result.sourceAssessments[0].reasons).toContain(reason);
    }
  );

  it("should block an unreadable cut-off before anything is delivered", () => {
    const result = assessControlRunReadiness(
      [source({ cutoffAt: new Date("not a timestamp"), received: undefined })],
      NOW
    );

    expect(result.status).toBe("blocked");
    expect(result.sourceAssessments[0].reasons).toContain("invalid_cutoff");
  });
});

describe("when a manifest from storage does not match its declared types", () => {
  it.each<[string, Record<string, unknown>, string]>([
    [
      "a numeric monetary total",
      { monetaryTotal: 1250.1 },
      "invalid_control_total",
    ],
    ["a textual record count", { recordCount: "2" }, "invalid_control_total"],
    ["no currency", { currency: undefined }, "invalid_control_total"],
    ["no batch identity", { batchId: undefined }, "missing_batch_identity"],
    ["a numeric batch identity", { batchId: 42 }, "missing_batch_identity"],
    ["no mapping version", { mappingVersion: null }, "missing_mapping_version"],
    [
      "a textual refused-row count",
      { invalidRowCount: "0" },
      "invalid_rows_present",
    ],
    [
      "a duplicate state it does not recognise",
      { duplicateDelivery: "maybe" },
      "unknown_duplicate_delivery_state",
    ],
    [
      "a receipt time stored as text",
      { receivedAt: "2026-10-09T15:55:00Z" },
      "invalid_received_at",
    ],
  ])(
    "should block %s rather than throw or pass it",
    (_label, fields, reason) => {
      const result = assessControlRunReadiness(
        [source({ received: loaded(fields) })],
        NOW
      );

      expect(result.status).toBe("blocked");
      expect(result.sourceAssessments[0].reasons).toContain(reason);
    }
  );

  it("should block a control-total flag that is truthy but not `true`", () => {
    const flagged = {
      ...source(),
      controlTotalRequired: "yes",
    } as unknown as RequiredSourceManifest;

    const result = assessControlRunReadiness([flagged], NOW);

    expect(result.status).toBe("blocked");
    expect(result.sourceAssessments[0].reasons).toEqual([
      "control_total_not_required",
    ]);
  });
});

describe("when a currency has three minor-unit digits", () => {
  const dinar = (receivedTotal: string) =>
    source({
      expected: { recordCount: 2, monetaryTotal: "1250.125", currency: "TND" },
      received: received({ monetaryTotal: receivedTotal, currency: "TND" }),
    });

  it("should accept an exactly matching total", () => {
    expect(assessControlRunReadiness([dinar("1250.125")], NOW).status).toBe(
      "ready_to_reconcile"
    );
  });

  it("should flag a total that differs only in the third decimal", () => {
    const result = assessControlRunReadiness([dinar("1250.126")], NOW);

    expect(result.status).toBe("incomplete");
    expect(result.sourceAssessments[0].reasons).toEqual([
      "monetary_total_mismatch",
    ]);
  });
});

describe("when an optional third source is missing", () => {
  it("should not stop a defined two-source control from proceeding", () => {
    const result = assessControlRunReadiness(
      [
        source(),
        register(),
        source({
          sourceKey: "bank_credit_evidence",
          role: "bank_or_gl",
          required: false,
          received: undefined,
        }),
      ],
      NOW
    );

    expect(result.status).toBe("ready_to_reconcile");
    expect(result.sourceAssessments[2]).toMatchObject({
      required: false,
      status: "incomplete",
    });
  });
});

describe("when the control definition itself is unusable", () => {
  it("should refuse to label an empty definition ready", () => {
    const result = assessControlRunReadiness([], NOW);

    expect(result).toMatchObject({
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
      reasons: ["no_required_sources"],
    });
  });

  it("should block a definition that lists one source key twice", () => {
    const result = assessControlRunReadiness([source(), source()], NOW);

    expect(result.status).toBe("blocked");
    expect(result.reasons).toEqual(["duplicate_source_key"]);
  });

  it("should fail closed when the evaluation clock is invalid", () => {
    const result = assessControlRunReadiness(
      [source()],
      new Date("not a timestamp")
    );

    expect(result).toMatchObject({
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
      reasons: ["invalid_evaluation_time"],
    });
  });

  it("should block a source assessed on its own against an invalid clock", () => {
    // assessSourceReadiness is exported, so it cannot rely on the run-level
    // check: on its own it would otherwise call valid evidence ready.
    const assessment = assessSourceReadiness(
      source(),
      new Date("not a timestamp")
    );

    expect(assessment.status).toBe("blocked");
    expect(assessment.reasons).toEqual(["invalid_evaluation_time"]);
  });
});

describe("when a source cannot be identified or placed", () => {
  it.each<[string, unknown]>([
    ["missing", undefined],
    ["blank", "   "],
    ["empty", ""],
    ["not text", 42],
  ])(
    "should block a source whose key is %s, and not name it",
    (_label, key) => {
      const unnamed = {
        ...source(),
        sourceKey: key,
      } as unknown as RequiredSourceManifest;

      const result = assessControlRunReadiness([unnamed], NOW);

      expect(result.status).toBe("blocked");
      expect(result.mayPublishMatchRate).toBe(false);
      expect(result.sourceAssessments[0]).toMatchObject({
        sourceKey: null,
        status: "blocked",
        reasons: ["missing_source_key"],
      });
    }
  );

  it("should block a source whose role this policy does not know", () => {
    const misplaced = {
      ...source(),
      role: "ledger",
    } as unknown as RequiredSourceManifest;

    const result = assessControlRunReadiness([misplaced], NOW);

    expect(result.status).toBe("blocked");
    expect(result.sourceAssessments[0]).toMatchObject({
      role: null,
      reasons: ["invalid_source_role"],
    });
  });

  it("should not count two unnamed sources as a duplicate key", () => {
    // Each is already blocked for having no key; reporting a collision
    // between two absent names would describe a problem that is not there.
    const unnamed = {
      ...source(),
      sourceKey: "",
    } as unknown as RequiredSourceManifest;

    const result = assessControlRunReadiness([unnamed, unnamed], NOW);

    expect(result.status).toBe("blocked");
    expect(result.reasons).toEqual([]);
  });

  it("should treat keys that differ only by surrounding spaces as one key", () => {
    const result = assessControlRunReadiness(
      [source(), source({ sourceKey: " processor_settlement " })],
      NOW
    );

    expect(result.reasons).toEqual(["duplicate_source_key"]);
  });
});

describe("when storage returns entries that are not manifests", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["a number", 0],
    ["a string", "processor_settlement"],
    ["an array", []],
  ])("should block an entry that is %s, without throwing", (_label, entry) => {
    const manifests = [source(), entry] as unknown as RequiredSourceManifest[];

    const result = assessControlRunReadiness(manifests, NOW);

    expect(result.status).toBe("blocked");
    expect(result.sourceAssessments[1]).toEqual({
      sourceKey: null,
      role: null,
      required: true,
      status: "blocked",
      reasons: ["invalid_source_manifest"],
      warnings: [],
    });
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["an object", { processor_settlement: source() }],
    ["a string", "processor_settlement"],
  ])(
    "should block a definition that is %s, without throwing",
    (_label, definition) => {
      const result = assessControlRunReadiness(
        definition as unknown as RequiredSourceManifest[],
        NOW
      );

      expect(result).toEqual({
        status: "blocked",
        canReconcile: false,
        mayPublishMatchRate: false,
        reasons: ["invalid_control_definition"],
        sourceAssessments: [],
      });
    }
  );

  it("should block a delivery record that is not an object, rather than treat it as not received", () => {
    const result = assessControlRunReadiness(
      [
        {
          ...source({ cutoffAt: LATER_CUTOFF }),
          received: "batch-settlement-20261009",
        } as unknown as RequiredSourceManifest,
      ],
      NOW
    );

    expect(result.status).toBe("blocked");
    expect(result.sourceAssessments[0].reasons).toEqual([
      "invalid_received_manifest",
    ]);
  });
});

describe("when any stored field holds a value it should never hold", () => {
  // The module promises to fail closed on whatever storage returns: never
  // throw, never approve. This holds it to that, field by field, rather than
  // trusting the promise. Values that ARE valid for a field are left out.
  const HOSTILE: unknown[] = [
    null,
    undefined,
    0,
    -1,
    NaN,
    "",
    "   ",
    "x",
    [],
    {},
    true,
  ];
  const LEGITIMATE: Record<string, unknown[]> = {
    sourceKey: ["x"],
    batchId: ["x"],
    sourceContractVersion: ["x"],
    mappingVersion: ["x"],
    invalidRowCount: [0],
    controlTotalRequired: [true],
  };
  const describeValue = (value: unknown) =>
    typeof value === "number" && Number.isNaN(value)
      ? "NaN"
      : value === undefined
        ? "undefined"
        : JSON.stringify(value);
  const casesFor = (fields: string[], level: "manifest" | "received") =>
    fields.flatMap(field =>
      HOSTILE.filter(value => !(LEGITIMATE[field] ?? []).includes(value)).map(
        value =>
          [
            `${level}.${field} = ${describeValue(value)}`,
            level,
            field,
            value,
          ] as const
      )
    );
  const cases = [
    ...casesFor(
      [
        "sourceKey",
        "role",
        "cutoffAt",
        "controlTotalRequired",
        "expected",
        "received",
      ],
      "manifest"
    ),
    ...casesFor(
      [
        "batchId",
        "receivedAt",
        "sourceContractVersion",
        "mappingVersion",
        "schemaState",
        "invalidRowCount",
        "duplicateDelivery",
        "recordCount",
        "monetaryTotal",
        "currency",
      ],
      "received"
    ),
  ];

  it.each(cases)(
    "should neither throw nor approve %s",
    (_label, level, field, value) => {
      const manifest =
        level === "manifest"
          ? ({
              ...source(),
              [field]: value,
            } as unknown as RequiredSourceManifest)
          : source({ received: loaded({ [field]: value }) });

      let result: ReturnType<typeof assessControlRunReadiness> | undefined;
      expect(() => {
        result = assessControlRunReadiness([manifest, register()], NOW);
      }).not.toThrow();

      expect(result?.status).not.toBe("ready_to_reconcile");
      expect(result?.mayPublishMatchRate).toBe(false);
    }
  );

  it.each(HOSTILE.filter(value => value !== false))(
    "should still count a source required when `required` is %s",
    value => {
      const flagged = {
        ...source({ received: undefined }),
        required: value,
      } as unknown as RequiredSourceManifest;

      const result = assessControlRunReadiness([flagged, register()], NOW);

      expect(result.sourceAssessments[0].required).toBe(true);
      expect(result.status).not.toBe("ready_to_reconcile");
    }
  );
});
