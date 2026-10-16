import { beforeEach, describe, expect, it, vi } from "vitest";

const s3 = vi.hoisted(() => ({ pages: [] as unknown[], requests: [] as Array<Record<string, unknown>> }));

vi.mock("./_core/env", () => ({
  ENV: {
    awsAccessKeyId: "test-access",
    awsSecretAccessKey: "test-secret",
    awsRegion: "auto",
    awsS3Bucket: "test-bucket",
    awsS3Endpoint: "",
  },
}));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  class S3Client {
    async send(command: { input: Record<string, unknown> }) {
      s3.requests.push(command.input);
      const page = s3.pages.shift();
      if (!page) throw new Error("unexpected request");
      return page;
    }
  }
  return { ...actual, S3Client };
});

import { storageListKeys } from "./storage";

beforeEach(() => {
  s3.pages = [];
  s3.requests = [];
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
