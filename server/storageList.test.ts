import { beforeEach, describe, expect, it, vi } from "vitest";

const s3 = vi.hoisted(() => ({
  pages: [] as unknown[],
  requests: [] as Array<Record<string, unknown>>,
  options: [] as unknown[],
}));

vi.mock("./_core/env", () => ({
  ENV: {
    awsAccessKeyId: "test-access",
    awsSecretAccessKey: "test-secret",
    awsRegion: "auto",
    awsS3Bucket: "test-bucket",
    awsS3Endpoint: "",
  },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed.example/object" }));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  class S3Client {
    async send(command: { input: Record<string, unknown> }, options?: unknown) {
      s3.requests.push(command.input);
      s3.options.push(options);
      const page = s3.pages.shift();
      if (!page) throw new Error("unexpected request");
      return page;
    }
  }
  return { ...actual, S3Client };
});

import { sameStorageBucket, storageDelete, storageListKeys, storagePut } from "./storage";

beforeEach(() => {
  s3.pages = [];
  s3.requests = [];
  s3.options = [];
});

describe("when a listing or a delete is given an abort signal", () => {
  it("should hand it to the S3 client on every page of a listing", async () => {
    s3.pages = [
      { Contents: [{ Key: "org/42/a" }], IsTruncated: true, NextContinuationToken: "t1" },
      { Contents: [{ Key: "org/42/b" }], IsTruncated: false },
    ];
    const deadline = new AbortController();

    await storageListKeys("org/42/", { abortSignal: deadline.signal });

    expect(s3.options).toEqual([{ abortSignal: deadline.signal }, { abortSignal: deadline.signal }]);
  });

  it("should send no further request once the signal has aborted", async () => {
    const deadline = new AbortController();
    deadline.abort(new Error("deadline passed"));

    await expect(storageListKeys("org/42/", { abortSignal: deadline.signal })).rejects.toThrow("deadline passed");
    expect(s3.requests).toEqual([]);
  });

  it("should hand it to the S3 client on a delete", async () => {
    s3.pages = [{}];
    const deadline = new AbortController();

    await storageDelete("org/42/a", { abortSignal: deadline.signal });

    expect(s3.options).toEqual([{ abortSignal: deadline.signal }]);
  });
});

describe("when an object is uploaded with a deadline", () => {
  it("should hand the abort signal to the S3 client", async () => {
    s3.pages = [{}];
    const deadline = new AbortController();

    await storagePut("org/42/a.csv", "x", "text/csv", { abortSignal: deadline.signal });

    expect(s3.options[0]).toEqual({ abortSignal: deadline.signal });
  });
});

describe("when a folder's keys are listed", () => {
  it("should follow continuation tokens to the last page", async () => {
    s3.pages = [
      { Contents: [{ Key: "org/42/a" }, { Key: "org/42/b" }], IsTruncated: true, NextContinuationToken: "t1" },
      { Contents: [{ Key: "org/42/c" }], IsTruncated: false },
    ];

    await expect(storageListKeys("org/42/")).resolves.toEqual(["org/42/a", "org/42/b", "org/42/c"]);
    expect(s3.requests).toEqual([
      { Bucket: "test-bucket", Prefix: "org/42/", ContinuationToken: undefined },
      { Bucket: "test-bucket", Prefix: "org/42/", ContinuationToken: "t1" },
    ]);
  });

  it("should drop any key outside the folder", async () => {
    s3.pages = [{ Contents: [{ Key: "org/42/a" }, { Key: "org/420/b" }, {}], IsTruncated: false }];

    await expect(storageListKeys("org/42/")).resolves.toEqual(["org/42/a"]);
  });

  it.each(["", "/", "org/42", "exports"])("should refuse %j, which is not a folder, without asking storage", async (prefix) => {
    await expect(storageListKeys(prefix)).rejects.toThrow("storage_list_prefix_invalid");
    expect(s3.requests).toEqual([]);
  });

  it.each([
    ["no continuation token", { Contents: [], IsTruncated: true }],
    ["the same continuation token again", { Contents: [], IsTruncated: true, NextContinuationToken: "t1" }],
  ])("should throw rather than return part of the folder when a truncated page carries %s", async (_label, page) => {
    s3.pages = [{ Contents: [{ Key: "org/42/a" }], IsTruncated: true, NextContinuationToken: "t1" }, page];

    await expect(storageListKeys("org/42/")).rejects.toThrow("storage_list_incomplete");
  });
});

describe("when two storage locations are compared", () => {
  const r2 = { bucket: "reconcileai-storage", endpoint: "https://acct.r2.cloudflarestorage.com" };

  it.each([
    ["the same endpoint written with a trailing slash and capitals", { bucket: "Reconcileai-Storage", endpoint: "HTTPS://ACCT.r2.cloudflarestorage.com/" }],
    ["the same endpoint with its default port spelled out", { bucket: "reconcileai-storage", endpoint: "https://acct.r2.cloudflarestorage.com:443" }],
  ])("should be one bucket for %s", (_label, other) => {
    expect(sameStorageBucket(r2, other)).toBe(true);
  });

  it.each([
    ["another host", { bucket: "reconcileai-storage", endpoint: "https://minio.merchant.example" }],
    ["another port on the same host", { bucket: "reconcileai-storage", endpoint: "https://acct.r2.cloudflarestorage.com:9000" }],
    ["another scheme on the same host", { bucket: "reconcileai-storage", endpoint: "http://acct.r2.cloudflarestorage.com" }],
    ["AWS S3", { bucket: "reconcileai-storage", endpoint: null }],
    ["another name", { bucket: "merchant-drop", endpoint: r2.endpoint }],
    ["an endpoint that is not a URL", { bucket: "reconcileai-storage", endpoint: "not a url" }],
  ])("should be different buckets for %s", (_label, other) => {
    expect(sameStorageBucket(r2, other)).toBe(false);
  });

  it.each([
    ["no endpoint", null],
    ["an empty endpoint", ""],
    ["a regional AWS endpoint", "https://s3.eu-west-1.amazonaws.com"],
  ])("should treat %s as AWS S3, where bucket names are global", (_label, endpoint) => {
    expect(sameStorageBucket({ bucket: "reconcileai-storage", endpoint: "" }, { bucket: "reconcileai-storage", endpoint })).toBe(true);
  });

  it("should match nothing when the platform has no bucket", () => {
    expect(sameStorageBucket({ bucket: "", endpoint: "" }, { bucket: "", endpoint: "" })).toBe(false);
  });
});
