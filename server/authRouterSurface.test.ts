/**
 * The `auth.*` surface, pinned.
 *
 * `auth.*` moved out of the 7,539-line `server/routers.ts` into
 * `server/routers/auth.ts`. A refactor that quietly drops, renames or retypes a
 * procedure is the failure mode worth guarding: every one of these is reached
 * by the client, two of them establish or end a session, and a missing one
 * shows up as a runtime 404 rather than a build error.
 *
 * So this asserts the surface rather than the implementation — names, and
 * whether each is a query or a mutation. It would have caught the extraction
 * going wrong, and it will catch the next person's.
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

/** What the client calls today. Changing this list is a deliberate act. */
const EXPECTED: Record<string, "query" | "mutation"> = {
  "auth.me": "query",
  "auth.oauthProviders": "query",
  "auth.mySegment": "query",
  "auth.requestMagicLink": "mutation",
  "auth.logout": "mutation",
  "auth.guestLogin": "mutation",
};

type ProcedureDef = { _def?: { type?: string } };

function authProcedures(): Record<string, string> {
  const procedures = (appRouter as unknown as { _def: { procedures: Record<string, ProcedureDef> } })._def.procedures;
  const out: Record<string, string> = {};
  for (const [path, proc] of Object.entries(procedures)) {
    if (path.startsWith("auth.")) out[path] = proc?._def?.type ?? "unknown";
  }
  return out;
}

describe("when auth procedures are mounted", () => {
  it("should expose exactly the same set of procedures as before the extraction", () => {
    expect(Object.keys(authProcedures()).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("should keep each one a query or a mutation as it was", () => {
    // A query silently becoming a mutation (or the reverse) breaks callers
    // without breaking the build — useQuery/useMutation are chosen client-side.
    expect(authProcedures()).toEqual(EXPECTED);
  });

  it("should find a non-trivial number of procedures, so the lookup cannot pass empty", () => {
    // Guards the guard: if `_def.procedures` ever changes shape, the two
    // assertions above would compare {} to {} and pass.
    expect(Object.keys(authProcedures()).length).toBe(6);
  });
});
