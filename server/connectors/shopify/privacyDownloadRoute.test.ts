/**
 * The privacy-export download route, driven for real.
 *
 * Delivery used to be recorded when a presigned URL was ISSUED: selectors were
 * destroyed and the request completed before the browser had fetched anything,
 * so a dropped connection left a "completed" request whose data never arrived.
 * The route now sends the bytes itself, and confirms delivery only on the
 * response's `finish` — every byte handed to the network — never on `close`.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
const state = vi.hoisted(() => ({
  db: { marker: "db" } as unknown,
  authenticate: vi.fn(),
  load: vi.fn(),
  read: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getDb: vi.fn(async () => state.db),
}));
vi.mock("../../_core/sdk", () => ({ sdk: { authenticateRequest: state.authenticate } }));
vi.mock("./privacyCompletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./privacyCompletion")>()),
  loadPrivacyArtifactForDownload: state.load,
  authorizeAndReadPrivacyArtifact: state.read,
  confirmPrivacyArtifactDeliveryWithRetry: state.confirm,
}));

import type express from "express";
import { PrivacyArtifactIntegrityError } from "./privacyCompletion";
import { createShopifyRouter } from "./routes";

const PUBLIC_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT = { requestId: 901, organizationId: 42, storeId: 7 };
const ACTOR = { id: 9, organizationId: 42, role: "admin", isActive: true };
const BYTES = Buffer.from('{"result":"zero_record_attestation"}\n', "utf8");

type Handler = (req: express.Request, res: express.Response) => Promise<unknown>;
type Layer = { route?: { path: string; stack: Array<{ handle: Handler }> } };

function downloadHandler(): Handler {
  const layer = (createShopifyRouter() as unknown as { stack: Layer[] }).stack.find(
    (l) => l.route?.path === "/api/shopify/privacy/artifacts/:publicId",
  );
  if (!layer?.route) throw new Error("download route not registered");
  return layer.route.stack[0].handle;
}

/** A response that records what it was sent, and can emit finish / close. */
function fakeResponse() {
  const emitter = new EventEmitter();
  const sent = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = Object.assign(emitter, {
    set(name: string, value: string) {
      sent.headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      sent.statusCode = code;
      return res;
    },
    send(body: unknown) {
      sent.body = body;
      return res;
    },
    end(body: unknown) {
      sent.body = body;
      return res;
    },
  });
  return { res, sent };
}

async function download() {
  const { res, sent } = fakeResponse();
  const req = { params: { publicId: PUBLIC_ID }, headers: {} } as unknown as express.Request;
  await downloadHandler()(req, res as unknown as express.Response);
  return { res, sent };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.authenticate.mockResolvedValue(ACTOR);
  state.load.mockResolvedValue(ARTIFACT);
  state.read.mockResolvedValue({ bytes: BYTES, filename: "shopify-customer-data-request-901.json" });
  state.confirm.mockResolvedValue("completed");
});

describe("when the claimant downloads an export", () => {
  it("should send the file itself — not a redirect to a presigned URL", async () => {
    const { sent } = await download();
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toBe(BYTES);
    expect(sent.headers["content-disposition"]).toBe('attachment; filename="shopify-customer-data-request-901.json"');
    expect(sent.headers["content-length"]).toBe(String(BYTES.length));
    expect(sent.headers["cache-control"]).toMatch(/no-store/);
  });

  it("should confirm delivery only once every byte has been written", async () => {
    const { res } = await download();
    expect(state.confirm).not.toHaveBeenCalled(); // issuing the file is not delivering it
    res.emit("finish");
    await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(1));
    expect(state.confirm).toHaveBeenCalledWith(state.db, ARTIFACT, ACTOR.id, expect.any(Date));
  });

  it("should never confirm when the client went away before the file was sent", async () => {
    const { res } = await download();
    res.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it("should refuse to send bytes that fail their integrity check, and confirm nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.read.mockRejectedValue(new PrivacyArtifactIntegrityError());
    const { res, sent } = await download();
    log.mockRestore();
    expect(sent.statusCode).toBe(409);
    res.emit("finish");
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it("should treat a deactivated account as signed out", async () => {
    state.authenticate.mockRejectedValue(new Error("This account has been deactivated"));
    const { sent } = await download();
    expect(sent.statusCode).toBe(401);
    expect(state.read).not.toHaveBeenCalled();
  });
});
