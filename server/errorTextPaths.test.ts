/**
 * Where a database error's text used to go, driven through the real code.
 *
 * Each case throws a drizzle error whose parameters hold a customer's email
 * (the shape drizzle-orm 0.44 produces: `Failed query: <sql>\nparams: <values>`)
 * and asserts the email, and the SQL, never reach what the path emits: the
 * HTTP answer a client receives, the server log, a stored status.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { publicProcedure, router } from "./_core/trpc";
import { logProcedureFailure } from "./errorText";
import { createQueue } from "./jobQueue";
import { modulesToProvision } from "./provisioning";

const EMAIL = "owner@example.com";
const LEAK = /owner@example\.com|insert into|Failed query|params/i;

function duplicateEmail(): DrizzleQueryError {
  const driver = Object.assign(new Error(`Duplicate entry '${EMAIL}' for key 'users.email'`), {
    code: "ER_DUP_ENTRY",
    errno: 1062,
    sqlMessage: `Duplicate entry '${EMAIL}' for key 'users.email'`,
  });
  return new DrizzleQueryError("insert into `users` (`email`) values (?)", [EMAIL], driver);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("when a procedure fails with a database error it did not catch", () => {
  const appRouter = router({
    boom: publicProcedure.query(() => {
      throw duplicateEmail();
    }),
    plain: publicProcedure.query(() => {
      throw new Error("Plain application failure");
    }),
  });

  const call = async (path: string) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request(`http://localhost/api/trpc/${path}`),
      router: appRouter,
      createContext: () => ({ user: null, req: { headers: {} }, res: {} }) as never,
      onError: logProcedureFailure,
    });
    const body = await response.text();
    return { body, logged: JSON.stringify(log.mock.calls) };
  };

  it("should answer the client with the database error's code, never its query or parameters", async () => {
    const { body } = await call("boom");
    expect(body).toContain("database error (ER_DUP_ENTRY)");
    expect(body).not.toMatch(LEAK);
  });

  it("should log the failure once, by code and where it was thrown, never its text", async () => {
    const { logged } = await call("boom");
    expect(logged).toContain("[trpc] boom failed:");
    expect(logged).toContain("ER_DUP_ENTRY");
    expect(logged).toContain("errorTextPaths.test.ts");
    expect(logged).not.toMatch(LEAK);
  });

  it("should leave an application error's message as it was", async () => {
    const { body } = await call("plain");
    expect(body).toContain("Plain application failure");
  });
});

describe("when a queued job exhausts its attempts on a database error", () => {
  it("should log the code and frames, never the error's text", async () => {
    vi.stubEnv("REDIS_URL", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    let finalFailure!: () => void;
    const failed = new Promise<void>((resolve) => (finalFailure = resolve));
    const queue = await createQueue<{ n: number }>(
      "log-safety-test",
      async () => {
        throw duplicateEmail();
      },
      { attempts: 1, onFinalFailure: async () => finalFailure() },
    );

    await queue.enqueue("job", { n: 1 });
    await failed;
    await vi.waitFor(() => expect(JSON.stringify(log.mock.calls)).toContain("exhausted 1 attempts"));

    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("ER_DUP_ENTRY");
    expect(logged).toContain('"frames":["at ');
    expect(logged).not.toMatch(LEAK);
  });
});

describe("when provisioning cannot read the tenant's segment", () => {
  it("should store the database error's code as the failure, never its text", async () => {
    const result = await modulesToProvision(async () => {
      throw duplicateEmail();
    });
    expect(result).toEqual({ failed: "database error (ER_DUP_ENTRY)" });
  });
});
