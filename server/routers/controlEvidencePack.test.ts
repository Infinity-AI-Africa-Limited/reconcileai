import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

const state = vi.hoisted(() => ({
  job: { id: 91, organizationId: 42 },
  pack: { state: "reconstructable" },
}));

vi.mock("./shared", async importOriginal => ({
  ...(await importOriginal<typeof import("./shared")>()),
  assertJobVisible: vi.fn(async () => state.job),
}));
vi.mock("../controlEvidencePack", () => ({
  buildGovernedControlEvidencePack: vi.fn(async () => state.pack),
}));

import { buildGovernedControlEvidencePack } from "../controlEvidencePack";
import { assertJobVisible } from "./shared";
import { controlEvidenceRouter } from "./controlEvidence";

const user = { id: 7, role: "operations", organizationId: 42, isGuest: false, isReadOnly: false };
const caller = () => controlEvidenceRouter.createCaller({ user, req: { headers: {}, ip: "127.0.0.1" }, res: {} } as never);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("when a governed evidence pack is requested by job id", () => {
  it("derives the resource tenant from the visible job instead of accepting an organization input", async () => {
    await expect(caller().getGovernedRunEvidencePack({ jobId: 91 })).resolves.toEqual(state.pack);

    expect(assertJobVisible).toHaveBeenCalledWith(user, 91);
    expect(buildGovernedControlEvidencePack).toHaveBeenCalledWith(state.job);
  });

  it("does not expose an organization override at the route boundary", async () => {
    await expect(caller().getGovernedRunEvidencePack({ jobId: 91, organizationId: 60001 } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(assertJobVisible).not.toHaveBeenCalled();
  });
});
