/**
 * Deployment Runbook — private-link boundary + document integrity.
 *
 * The runbook is served to prospects, partner IT teams and bank security
 * reviewers through a POC-style invite link. Two things must hold:
 *   1. the link is a real boundary (no token / wrong token => refused), and
 *   2. the externally-shared copy stays free of internal-only material.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ─── Mock the DB so the access checks run against a controllable row ────────
let accessRow: { pocKey: string; token: string; enabled: boolean } | null = null;

const mockDb = {
  select: () => mockDb,
  from: () => mockDb,
  where: () => mockDb,
  limit: async () => (accessRow ? [accessRow] : []),
};

vi.mock("./db", () => ({ getDb: async () => mockDb }));

import { assertPocAccess, checkPocAccess } from "./pocAccess";
import {
  RUNBOOK_MARKDOWN,
  RUNBOOK_SUBTITLE,
  RUNBOOK_TITLE,
  RUNBOOK_UPDATED,
  RUNBOOK_VERSION,
} from "./content/deploymentRunbook";

const KEY = "deployment_runbook";
const TOKEN = "a-valid-invite-token";

describe("Deployment runbook — private invite link is a real boundary", () => {
  beforeEach(() => {
    accessRow = { pocKey: KEY, token: TOKEN, enabled: true };
  });

  it("grants access with the exact invite token", async () => {
    expect(await checkPocAccess(KEY, TOKEN)).toBe(true);
    await expect(assertPocAccess(KEY, TOKEN)).resolves.toBeUndefined();
  });

  it("refuses when no token is presented", async () => {
    expect(await checkPocAccess(KEY, undefined)).toBe(false);
    expect(await checkPocAccess(KEY, null)).toBe(false);
    expect(await checkPocAccess(KEY, "")).toBe(false);
    await expect(assertPocAccess(KEY, undefined)).rejects.toThrow(/Invalid or missing access code/i);
  });

  it("refuses a wrong token", async () => {
    expect(await checkPocAccess(KEY, "not-the-token")).toBe(false);
    await expect(assertPocAccess(KEY, "not-the-token")).rejects.toThrow(/Invalid or missing access code/i);
  });

  it("refuses when the document has no access row at all (secure by default)", async () => {
    accessRow = null;
    expect(await checkPocAccess(KEY, TOKEN)).toBe(false);
    await expect(assertPocAccess(KEY, TOKEN)).rejects.toThrow(/not yet available/i);
  });

  it("regenerating the token invalidates links already sent out", async () => {
    const oldLinkToken = TOKEN;
    accessRow = { pocKey: KEY, token: "freshly-regenerated-token", enabled: true };
    expect(await checkPocAccess(KEY, oldLinkToken)).toBe(false);
    expect(await checkPocAccess(KEY, "freshly-regenerated-token")).toBe(true);
  });
});

describe("Deployment runbook — document integrity", () => {
  it("exports a complete document with its metadata", () => {
    expect(RUNBOOK_TITLE).toMatch(/Local Deployment/i);
    expect(RUNBOOK_SUBTITLE.length).toBeGreaterThan(20);
    expect(RUNBOOK_VERSION).toMatch(/^\d+\.\d+$/);
    expect(RUNBOOK_UPDATED.length).toBeGreaterThan(3);
    expect(RUNBOOK_MARKDOWN.length).toBeGreaterThan(10_000);
  });

  it("contains every track and the load-bearing sections", () => {
    for (const heading of [
      "Purpose, scope, and markets",
      "The architecture, in plain English",
      "Platform prerequisites",
      "Track A",
      "Track B",
      "Track C",
      "Compliance controls",
      "Handover & acceptance tests",
      "Environment reference",
    ]) {
      expect(RUNBOOK_MARKDOWN).toContain(heading);
    }
  });

  it("keeps the two steps that make an air-gapped install actually complete", () => {
    // The first-login bootstrap and the in-container migration command are the
    // corrections that distinguish this revision — losing either silently would
    // ship a runbook that cannot be executed end to end.
    expect(RUNBOOK_MARKDOWN).toContain("bootstrap-admin.mjs");
    expect(RUNBOOK_MARKDOWN).toContain("npx drizzle-kit migrate");
    expect(RUNBOOK_MARKDOWN).toContain("DEPLOYMENT_MODE=on_premise");
  });

  it("has balanced code fences and no broken template escaping", () => {
    const fences = RUNBOOK_MARKDOWN.match(/```/g) ?? [];
    expect(fences.length % 2).toBe(0);
    expect(RUNBOOK_MARKDOWN).not.toContain("\\`");
    expect(RUNBOOK_MARKDOWN).not.toContain("\\${");
  });

  it("stays free of internal-only material (it is shared outside the company)", () => {
    for (const internal of ["Manus", "acting CTO", "CTO laptop", "project-deployment-modes"]) {
      expect(RUNBOOK_MARKDOWN).not.toContain(internal);
    }
  });

  it("is served read-only — no print, PDF export or download route out of the page", () => {
    // The runbook is shared with prospects and bank reviewers for on-screen
    // reading only. A print button, a PDF export, or a download-blob would each
    // hand over the whole document, so none may reappear in the page.
    const page = fs.readFileSync(
      path.resolve(process.cwd(), "client/src/pages/DeploymentRunbook.tsx"),
      "utf8",
    );

    expect(page).not.toMatch(/window\.print\s*\(/);
    expect(page).not.toMatch(/createObjectURL/);
    expect(page).not.toMatch(/\.download\s*=/);

    // …and the on-screen copy deterrents stay wired.
    expect(page).toContain("user-select: none");
    expect(page).toContain("@media print");
    for (const evt of ["copy", "cut", "contextmenu"]) {
      expect(page).toContain(`document.addEventListener("${evt}"`);
    }
  });

  it("carries no credentials or live secrets", () => {
    expect(RUNBOOK_MARKDOWN).not.toMatch(/sk-ant-[A-Za-z0-9-]+/);
    expect(RUNBOOK_MARKDOWN).not.toMatch(/\bre_[A-Za-z0-9]{16,}/);
    // The Woodcore test-tenant host must never appear in an externally shared doc.
    expect(RUNBOOK_MARKDOWN).not.toContain("203.123.87.130");
  });
});
