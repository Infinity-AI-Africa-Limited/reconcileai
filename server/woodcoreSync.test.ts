/**
 * What a Woodcore mirror sync reports when something fails.
 *
 * The scheduled workflow judges a run by these statuses, so a failure that
 * reads as `skipped` or `ok` is a failure nobody is told about. Both databases
 * are fakes here: the point is how each kind of failure is classified, not
 * the copying.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A mysql2 server error: it carries a code and the server's own message. */
function serverError(code: string): Error {
  return Object.assign(new Error(`${code}: refused`), { code, sqlMessage: "refused" });
}

/** A mysql2 connection error: a code, and no server message. */
function connectionError(code: string): Error {
  return Object.assign(new Error(`connect ${code} 192.0.2.1:3306`), { code });
}

const fakes = vi.hoisted(() => ({
  woodcoreQuery: vi.fn(),
  appQuery: vi.fn(),
}));

vi.mock("./_core/env", () => ({ ENV: { databaseUrl: "mysql://app.invalid/test" } }));
vi.mock("./woodcoreDb", () => ({ getWoodcorePool: () => ({ query: fakes.woodcoreQuery }) }));
vi.mock("./dbSession", () => ({ createAppPool: () => ({ promise: () => ({ query: fakes.appQuery }) }) }));

const { probeFailureStatus, syncState, syncWoodcoreMirror } = await import("./woodcoreSync");

/** A Woodcore that answers every probe and has no rows to copy. */
function woodcoreAnswers(refuseSelectOn: (sql: string) => Error | null = () => null) {
  fakes.woodcoreQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith("SHOW COLUMNS")) return [[{ Field: "id" }]];
    const refusal = refuseSelectOn(sql);
    if (refusal) throw refusal;
    return [[]];
  });
}

const BRIDGE_TABLES = ["wc_acc_to_gl_journal_entry", "wc_acc_to_gl_journal_entry_savings"];

function statusOf(mirror: string) {
  return syncState.tables.find((t) => t.mirror === mirror)?.status;
}

beforeEach(() => {
  fakes.woodcoreQuery.mockReset();
  fakes.appQuery.mockReset();
  fakes.appQuery.mockResolvedValue([[]]);
});

describe("when a probe fails for one table", () => {
  it("should skip the table only for a refusal on that table, or a table that does not exist", () => {
    expect(probeFailureStatus(serverError("ER_TABLEACCESS_DENIED_ERROR"))).toBe("skipped");
    expect(probeFailureStatus(serverError("ER_COLUMNACCESS_DENIED_ERROR"))).toBe("skipped");
    expect(probeFailureStatus(serverError("ER_NO_SUCH_TABLE"))).toBe("skipped");
  });

  it("should report an error for anything that stops the whole sync reading Woodcore", () => {
    expect(probeFailureStatus(connectionError("ECONNREFUSED"))).toBe("error");
    expect(probeFailureStatus(connectionError("ETIMEDOUT"))).toBe("error");
    expect(probeFailureStatus(serverError("ER_ACCESS_DENIED_ERROR"))).toBe("error");
    expect(probeFailureStatus(serverError("ER_HOST_NOT_PRIVILEGED"))).toBe("error");
    expect(probeFailureStatus(serverError("ER_DBACCESS_DENIED_ERROR"))).toBe("error");
    expect(probeFailureStatus(new Error("no code at all"))).toBe("error");
    expect(probeFailureStatus("not an error")).toBe("error");
    expect(probeFailureStatus(null)).toBe("error");
  });
});

describe("when the Woodcore database cannot be reached", () => {
  it("should finish with every table in error, and the mirror untouched", async () => {
    fakes.woodcoreQuery.mockRejectedValue(connectionError("ECONNREFUSED"));

    await syncWoodcoreMirror();

    expect(syncState.running).toBe(false);
    expect(syncState.finishedAt).not.toBeNull();
    expect(syncState.tables.length).toBeGreaterThan(0);
    expect(syncState.tables.every((t) => t.status === "error")).toBe(true);
    // A failed probe never truncates: nothing was written to the app database.
    expect(fakes.appQuery).not.toHaveBeenCalled();
  });
});

describe("when only the bridge tables are refused", () => {
  it("should skip those two and refresh the rest", async () => {
    woodcoreAnswers((sql) =>
      sql.includes("FROM `acc_to_gl_journal_entry") ? serverError("ER_TABLEACCESS_DENIED_ERROR") : null,
    );

    await syncWoodcoreMirror();

    for (const mirror of BRIDGE_TABLES) expect(statusOf(mirror)).toBe("skipped");
    const others = syncState.tables.filter((t) => !BRIDGE_TABLES.includes(t.mirror));
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((t) => t.status === "ok")).toBe(true);
    expect(syncState.error).toBeNull();
  });
});

describe("when the app database refuses the sync's login", () => {
  it("should report each table it could not write as an error, by code alone", async () => {
    // The production incident of 2026-10-26: Woodcore answers, our database refuses.
    woodcoreAnswers();
    fakes.appQuery.mockRejectedValue(serverError("ER_ACCESS_DENIED_ERROR"));

    await syncWoodcoreMirror();

    expect(syncState.tables.length).toBeGreaterThan(0);
    expect(syncState.tables.every((t) => t.status === "error")).toBe(true);
    expect(syncState.tables.every((t) => t.reason === "database error (ER_ACCESS_DENIED_ERROR)")).toBe(true);
  });
});
