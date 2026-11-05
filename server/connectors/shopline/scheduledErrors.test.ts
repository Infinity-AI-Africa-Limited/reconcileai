/**
 * What the three SHOPLINE scheduled handlers answer when they fail outright.
 *
 * The scheduler prints the response body into the Actions log, and the
 * repository is public. So the body carries the error's summary and an id,
 * and the stack frames stay in the server log under that same id. The
 * failure here is the one production has had since 2026-10-26: the database
 * refuses the login on the handler's first query.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../db", () => ({
  getDb: vi.fn(async () => ({
    select: () => {
      throw Object.assign(new Error("Access denied for user 'app'@'10.0.0.7' (using password: YES)"), {
        code: "ER_ACCESS_DENIED_ERROR",
        errno: 1045,
        sqlState: "28000",
        sqlMessage: "Access denied for user 'app'@'10.0.0.7' (using password: YES)",
      });
    },
  })),
}));
vi.mock("./webhookHandler", () => ({ replayStalledWebhookEvents: vi.fn(async () => null) }));

const { handleShoplineDailyBatch, handleShoplineSyncCycle, handleShoplineWebhookReconciler } = await import(
  "./scheduledSync"
);

type Answer = { status: number; body: Record<string, unknown> };

async function call(handler: (req: Request, res: Response) => Promise<void>): Promise<Answer> {
  const answer: Answer = { status: 200, body: {} };
  const res = {
    status(code: number) {
      answer.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      answer.body = body;
      return this;
    },
  };
  const req = { url: "/api/scheduled/handler", headers: {}, query: {} };
  await handler(req as unknown as Request, res as unknown as Response);
  return answer;
}

let logged: unknown[][] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  ["the 15-minute sync cycle", handleShoplineSyncCycle, "shoplineSyncCycle"],
  ["the daily batch", handleShoplineDailyBatch, "shoplineDailyBatch"],
  ["the webhook reconciler", handleShoplineWebhookReconciler, "shoplineWebhookReconciler"],
] as const)("when %s fails outright", (_name, handler, label) => {
  it("should answer 500 with the error's summary, and no stack or path", async () => {
    const { status, body } = await call(handler);

    expect(status).toBe(500);
    expect(body.error).toBe("database error (ER_ACCESS_DENIED_ERROR)");
    expect(body).not.toHaveProperty("frames");
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/\.(ts|js|mjs):\d+/);
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain(" at ");
    expect(text).not.toContain("Access denied for user");
    expect(text).not.toContain("10.0.0.7");
  });

  it("should keep the frames in the server log, under the id the response carries", async () => {
    const { body } = await call(handler);

    expect(body.errorId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    const entry = logged.find(([message]) => String(message).startsWith(`[${label}] fatal error`));
    expect(entry, `a [${label}] fatal error log line`).toBeDefined();
    expect(String(entry![0])).toContain(String(body.errorId));
    const details = entry![1] as { frames?: string[] };
    expect(details.frames?.length ?? 0).toBeGreaterThan(0);
  });
});
