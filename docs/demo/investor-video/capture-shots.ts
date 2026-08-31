/**
 * capture-shots.ts — regenerate every video frame as a PNG, and REFUSE to save
 * a frame that does not show what the narration claims.
 *
 *   pnpm add -D playwright && npx playwright install chromium
 *   npx tsx docs/demo/investor-video/capture-shots.ts
 *
 * Playwright is NOT a dependency of this repo — installing it pulls a browser
 * binary the product does not need. Install it in the capture environment only,
 * which is why this file lives beside the script it serves rather than in
 * scripts/.
 *
 * WHY EVERY SHOT ASSERTS BEFORE IT SCREENSHOTS
 *
 * A screenshot always succeeds. That is the problem. A reviewer token that has
 * expired, been revoked, or been rate-limited does not fail navigation — it
 * REDIRECTS, to a login page or a landing page, or leaves the previous tenant's
 * session in place. A blind capture loop then photographs the wrong page, or
 * the previous vertical's data, saves it under the next vertical's filename,
 * and exits 0. Nothing looks wrong until an investor reads a number aloud.
 *
 * So each shot declares what must be on screen, and the run fails loudly if it
 * is not there. The whole point of this package is that the frames and the
 * narration agree; a capture step that cannot detect disagreement is not doing
 * its job.
 *
 * HOW IT AUTHENTICATES
 *
 * Through the product's own reviewer-access mechanism: a read-only,
 * tenant-scoped session (server/reviewerAccess.ts). No password is handled
 * here, and the session cannot write — a capture run can never alter the data
 * it is photographing.
 *
 * Mint the links first (super admin → POC Hub → "Reviewer access links"), then:
 *
 *   export SHOT_BASE_URL=http://localhost:5177
 *   export SHOT_TOKEN_FS=...      # tenant-scoped link for the FS demo org
 *   export SHOT_TOKEN_B2B=...
 *   export SHOT_TOKEN_RETAIL=...
 *
 * Run it straight after `pnpm demo:finserv:activate`. Seeded exception ages are
 * relative to activation time, and the oldest FS case sits on the "Last 7 days"
 * boundary — leave it a day and that case drops out of the filter. The count
 * assertion below turns that from a silently wrong frame into a failed run.
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.SHOT_BASE_URL ?? "http://localhost:5177";
const OUT = join(process.cwd(), "docs", "demo", "investor-video", "shots");

type Vertical = "fs" | "b2b" | "retail";

/** The tenant each token must land in. Asserted after every swap. */
const TENANT_NAME: Record<Vertical, string> = {
  fs: "ReconcileAI Guest Demo",
  b2b: "BrightGoods",
  retail: "ReconcileAI Dev Store",
};

type Shot = {
  id: string;
  vertical: Vertical;
  path: string;
  /** Every one of these must be visible before the frame is saved. */
  expect: string[];
  prepare?: (page: Page) => Promise<void>;
};

const SHOTS: Shot[] = [
  {
    id: "SHOT-01", vertical: "fs", path: "/dashboard",
    expect: ["640", "95.0%"],
  },
  {
    id: "SHOT-02", vertical: "fs", path: "/channels",
    // Eight rails is the claim the narration makes; Agent Banking specifically
    // is the rail an earlier indexing defect silently dropped, so it is named.
    expect: ["Agent Banking", "NIBSS NIP", "Core Banking"],
  },
  {
    id: "SHOT-03", vertical: "fs", path: "/exceptions",
    // Defaults to Today, and the seeded cases are aged 0–7 days, so the default
    // view is nearly empty. "Last 7 days" is the widest preset available.
    prepare: async (page) => {
      await page.getByRole("button", { name: "Last 7 days" }).click();
      await page.waitForTimeout(2500);
    },
    // The narration says "sixteen cases". If seeding has aged past the filter
    // boundary this will not be on screen, and the run must stop rather than
    // save a frame showing fifteen.
    expect: ["16"],
  },
  {
    id: "SHOT-04", vertical: "b2b", path: "/dashboard",
    expect: ["2,000", "95.0%"],
  },
  {
    id: "SHOT-05", vertical: "b2b", path: "/distributors",
    expect: ["Distributor"],
  },
  {
    id: "SHOT-06", vertical: "retail", path: "/settlement-monitor",
    // Retail leads on the CONNECTION, not on volume — see README §Retail.
    expect: ["Settlement"],
  },
  {
    id: "SHOT-07", vertical: "retail", path: "/settlement-monitor",
    prepare: async (page) => { await page.mouse.wheel(0, 900); await page.waitForTimeout(1200); },
    expect: ["Intelligence"],
  },
  {
    id: "SHOT-08", vertical: "fs", path: "/exception-intelligence",
    expect: ["Intelligence"],
  },
  {
    id: "SHOT-09", vertical: "fs", path: "/exception-intelligence",
    prepare: async (page) => { await page.mouse.wheel(0, 700); await page.waitForTimeout(1200); },
    expect: ["Intelligence"],
  },
];

const TOKENS: Record<Vertical, string | undefined> = {
  fs: process.env.SHOT_TOKEN_FS,
  b2b: process.env.SHOT_TOKEN_B2B,
  retail: process.env.SHOT_TOKEN_RETAIL,
};

/** Fail loudly, naming the shot and what was missing. */
class ShotError extends Error {}

async function assertVisible(page: Page, shotId: string, needles: string[]) {
  const body = (await page.textContent("body")) ?? "";
  const missing = needles.filter((n) => !body.includes(n));
  if (missing.length) {
    throw new ShotError(
      `${shotId}: expected text not on screen: ${missing.map((m) => JSON.stringify(m)).join(", ")}\n` +
      `  url now: ${page.url()}\n` +
      `  This usually means the reviewer token redirected (expired/revoked), or the\n` +
      `  dataset drifted. Re-run 'pnpm demo:verify', re-activate, re-mint the link.`,
    );
  }
}

async function swapTenant(page: Page, vertical: Vertical) {
  await page.goto(`${BASE}/api/reviewer-access?key=${encodeURIComponent(TOKENS[vertical]!)}`, { waitUntil: "networkidle" });
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const body = (await page.textContent("body")) ?? "";
  // A redirect to login, or a still-live previous session, both land here — and
  // both would otherwise be photographed under the next vertical's filename.
  if (!body.includes(TENANT_NAME[vertical])) {
    throw new ShotError(
      `tenant swap to '${vertical}' did not take: expected "${TENANT_NAME[vertical]}" on screen.\n` +
      `  url now: ${page.url()}\n` +
      `  The token is probably expired or revoked. Mint a fresh tenant-scoped link.`,
    );
  }
}

async function main() {
  const missing = (Object.keys(TOKENS) as Vertical[]).filter((k) => !TOKENS[k]);
  if (missing.length) throw new Error(`Missing reviewer tokens for: ${missing.join(", ")}. See the header of this file.`);

  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  // 1440x900 crops cleanly to 16:9 without losing the sidebar, which carries
  // the per-vertical navigation the script points at.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  let current: Vertical | null = null;
  try {
    for (const shot of SHOTS) {
      if (shot.vertical !== current) {
        await swapTenant(page, shot.vertical);
        current = shot.vertical;
      }
      await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(3000); // let the tRPC queries settle
      if (shot.prepare) await shot.prepare(page);
      await assertVisible(page, shot.id, shot.expect);

      const file = join(OUT, `${shot.id}-${shot.vertical}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`OK  ${shot.id}  ${shot.vertical.padEnd(6)} ${shot.path.padEnd(24)} -> ${file}`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${SHOTS.length} frames written to ${OUT}`);
  console.log("Each was verified to contain its key figures before saving.");
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  console.error("No further frames captured. Fix the above and re-run — a partial");
  console.error("set is fine, but a wrong frame is not.\n");
  process.exit(1);
});
