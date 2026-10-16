/**
 * Server code stores a tenant's file through `putTenantObject`
 * (server/tenantStorage.ts), which keys it under the tenant and refuses a
 * tenant being deleted. That is what lets erasure find every file by listing
 * `org/<id>/`: one export written straight to storage under a user's id is a
 * file erasure can no longer see (Greptile #200).
 *
 * So naming the raw upload helpers is allowed only in the files below, each
 * for a stated reason. Read as syntax, not text: an identifier in an import
 * (renamed or not), a destructuring or a property access counts; a comment or
 * a string does not. The scanner is tested on those forms first, then run
 * over the server.
 *
 * The S3 SDK itself is held to the same rule: a file that builds its own
 * client could write to the bucket without passing the gate at all.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SERVER = __dirname;
const RAW_UPLOADS = new Set(["storagePut", "storagePutPrivate"]);

/** The only files that may upload directly, and why. */
const DIRECT_UPLOADERS: Record<string, string> = {
  "storage.ts": "Defines the raw helpers.",
  "tenantStorage.ts": "putTenantObject itself: the gate every tenant file passes.",
  "connectors/shopify/privacyCompletion.ts":
    "Shopify privacy exports: a private object under org/<id>/privacy/, fenced against shop redaction under lock, and recorded in shopify_privacy_artifacts.",
  "routers/poc.ts": "POC uploads belong to a public POC page's slug, not to a tenant; poc_file_uploads records each key.",
  "_core/imageGeneration.ts": "Generated images from a prompt; no tenant data.",
  "storageHealth.ts": "The /api/health storage probe writes, lists and deletes one probe object under health-checks/; no tenant data.",
};

/** The only files that may load the S3 SDK, and why. */
const S3_SDK_IMPORTERS: Record<string, string> = {
  "storage.ts": "The platform bucket's own client.",
  "bucketIngestionService.ts":
    "Reads a tenant's configured ingestion bucket and archives within it. It stores nothing under org/<id>/, and a source on the platform's own bucket stops shop redaction for a person (shopRedaction.ts).",
};
const S3_SDK = /^@aws-sdk\/(client-s3|lib-storage)(\/|$)/;

/** Lines in `text` that load the S3 SDK — by import, re-export, dynamic import or require. */
function s3SdkImportLines(file: string, text: string): number[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const lines: number[] = [];
  const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      S3_SDK.test(node.moduleSpecifier.text)
    ) {
      lines.push(at(node));
    }
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const loads =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (loads && first && ts.isStringLiteralLike(first) && S3_SDK.test(first.text)) lines.push(at(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

/** Lines in `text` that name a raw upload helper as code. */
function rawUploadLines(file: string, text: string): number[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && RAW_UPLOADS.has(node.text)) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

function serverSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : serverSources(full);
    return /\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name) && !entry.name.endsWith(".testkit.ts")
      ? [full]
      : [];
  });
}

describe("when the scanner reads a file", () => {
  it.each([
    ["a named import", 'import { storagePut } from "./storage";'],
    ["a renamed import", 'import { storagePut as put } from "./storage";\nput("k", "b");'],
    ["a dynamic import", 'const { storagePutPrivate } = await import("./storage");'],
    ["a namespace call", 'import * as s from "./storage";\ns.storagePut("k", "b");'],
  ])("should find %s", (_label, text) => {
    expect(rawUploadLines("fixture.ts", text).length).toBeGreaterThan(0);
  });

  it("should ignore a mention in a comment or a string", () => {
    expect(rawUploadLines("fixture.ts", '// storagePut is not called here\nconst s = "storagePut";')).toEqual([]);
  });

  it.each([
    ["a static import", 'import { S3Client } from "@aws-sdk/client-s3";'],
    ["a dynamic import", 'const sdk = await import("@aws-sdk/client-s3");'],
    ["a require", 'const sdk = require("@aws-sdk/lib-storage");'],
    ["a re-export", 'export { S3Client } from "@aws-sdk/client-s3";'],
  ])("should find the S3 SDK loaded by %s", (_label, text) => {
    expect(s3SdkImportLines("fixture.ts", text)).toHaveLength(1);
  });

  it("should not mistake another AWS client for the S3 SDK", () => {
    expect(s3SdkImportLines("fixture.ts", 'const kms = await import("@aws-sdk/client-kms");')).toEqual([]);
  });
});

describe("when server code stores a file", () => {
  it("should go through putTenantObject, unless its file is listed with a reason", () => {
    const offenders = serverSources(SERVER).flatMap((full) => {
      const relative = path.relative(SERVER, full).split(path.sep).join("/");
      if (relative in DIRECT_UPLOADERS) return [];
      return rawUploadLines(relative, fs.readFileSync(full, "utf8")).map((line) => `${relative}:${line}`);
    });
    expect(offenders).toEqual([]);
  });

  it("should list only files that exist and still upload directly", () => {
    const stale = Object.keys(DIRECT_UPLOADERS).filter((relative) => {
      const full = path.join(SERVER, relative);
      return !fs.existsSync(full) || rawUploadLines(relative, fs.readFileSync(full, "utf8")).length === 0;
    });
    expect(stale).toEqual([]);
  });

  it("should not build its own S3 client, unless its file is listed with a reason", () => {
    const offenders = serverSources(SERVER).flatMap((full) => {
      const relative = path.relative(SERVER, full).split(path.sep).join("/");
      if (relative in S3_SDK_IMPORTERS) return [];
      return s3SdkImportLines(relative, fs.readFileSync(full, "utf8")).map((line) => `${relative}:${line}`);
    });
    expect(offenders).toEqual([]);
  });

  it("should list only S3 SDK importers that exist and still load it", () => {
    const stale = Object.keys(S3_SDK_IMPORTERS).filter((relative) => {
      const full = path.join(SERVER, relative);
      return !fs.existsSync(full) || s3SdkImportLines(relative, fs.readFileSync(full, "utf8")).length === 0;
    });
    expect(stale).toEqual([]);
  });
});
