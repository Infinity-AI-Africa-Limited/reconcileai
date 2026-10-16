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
  "_core/index.ts": "The storage health probe writes a timestamped probe object, then deletes it; no tenant data.",
};

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
});
