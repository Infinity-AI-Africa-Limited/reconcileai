/**
 * capture-shots.ts — regenerate every video frame as a PNG, reproducibly.
 *
 *   pnpm add -D playwright && npx playwright install chromium
 *   npx tsx docs/demo/investor-video/capture-shots.ts
 *
 * Playwright is NOT a dependency of this repo — installing it pulls a browser
 * binary, which is not something the product needs. Install it in the capture
 * environment only, which is why this file lives beside the script it serves
 * rather than in scripts/.
 *
 * WHY THIS EXISTS RATHER THAN "TAKE SOME SCREENSHOTS"
 *
 * The shots have to agree with the narration. If someone re-seeds a tenant and
 * recaptures by hand, the dashboard says 640 while the voiceover says something
 * else, and nobody notices until an investor does. Running this after
 * `pnpm demo:verify` means the frames and the figures come from the same state.
 *
 * HOW IT AUTHENTICATES
 *
 * Through the product's own reviewer-access mechanism: a short-lived, read-only,
 * tenant-scoped session (server/reviewerAccess.ts). No password is handled here,
 * and the session cannot write — so a capture run can never alter the data it is
 * photographing.
 *
 * Mint the links first (super admin → POC Hub → "Reviewer access links", or
 * issueReviewerLink), then export them:
 *
 *   export SHOT_BASE_URL=http://localhost:5177
 *   export SHOT_TOKEN_FS=...      # tenant-scoped link for the FS demo org
 *   export SHOT_TOKEN_B2B=...
 *   export SHOT_TOKEN_RETAIL=...
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.SHOT_BASE_URL ?? "http://localhost:5177";
const OUT = join(process.cwd(), "docs", "demo", "investor-video", "shots");

type Shot = {
  id: string;
  vertical: "fs" | "b2b" | "retail";
  path: string;
  /** Run before capturing — e.g. widen a date filter that defaults to Today. */
  prepare?: (page: Page) => Promise<void>;
  note: string;
};

const SHOTS: Shot[] = [
  { id: "SHOT-01", vertical: "fs", path: "/dashboard", note: "640 legs, 95.0%, 16 unmatched" },
  { id: "SHOT-02", vertical: "fs", path: "/channels", note: "per-rail match rates" },
  {
    id: "SHOT-03", vertical: "fs", path: "/exceptions",
    // The page defaults to Today, and the seeded cases are aged 0–23 days, so
    // the default view is empty. This is the single most likely way to capture
    // a misleading frame.
    prepare: async (page) => { await page.getByRole("button", { name: "Last 7 days" }).click(); await page.waitForTimeout(2500); },
    note: "16 cases with category, severity, suggested resolution",
  },
  { id: "SHOT-04", vertical: "b2b", path: "/dashboard", note: "2,000 txns, ERP vs bank statement" },
  { id: "SHOT-05", vertical: "b2b", path: "/distributors", note: "15 distributors, aliases" },
  { id: "SHOT-06", vertical: "retail", path: "/settlement-monitor", note: "connected store, active, last sync" },
  { id: "SHOT-07", vertical: "retail", path: "/settlement-monitor", note: "scroll to Exception Resolution Intelligence", prepare: async (page) => { await page.mouse.wheel(0, 900); await page.waitForTimeout(1200); } },
  { id: "SHOT-08", vertical: "fs", path: "/exception-intelligence", note: "per-institution flywheel" },
  { id: "SHOT-09", vertical: "fs", path: "/exception-intelligence", note: "cross-institution, privacy-first", prepare: async (page) => { await page.mouse.wheel(0, 700); await page.waitForTimeout(1200); } },
];

const TOKENS: Record<Shot["vertical"], string | undefined> = {
  fs: process.env.SHOT_TOKEN_FS,
  b2b: process.env.SHOT_TOKEN_B2B,
  retail: process.env.SHOT_TOKEN_RETAIL,
};

async function main() {
  const missing = Object.entries(TOKENS).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing reviewer tokens for: ${missing.join(", ")}. See the header of this file.`);

  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  // 1440x900 is a 16:10 frame that crops cleanly to 16:9 without losing the
  // sidebar, which carries the per-vertical navigation the script points at.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  let current: Shot["vertical"] | null = null;
  for (const shot of SHOTS) {
    if (shot.vertical !== current) {
      // Reviewer links set the session cookie themselves; visiting one swaps
      // tenant without any credential being typed.
      await page.goto(`${BASE}/api/reviewer-access?key=${encodeURIComponent(TOKENS[shot.vertical]!)}`, { waitUntil: "networkidle" });
      current = shot.vertical;
    }
    await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(3000); // let the tRPC queries settle
    if (shot.prepare) await shot.prepare(page);
    const file = join(OUT, `${shot.id}-${shot.vertical}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`${shot.id}  ${shot.vertical.padEnd(6)} ${shot.path.padEnd(24)} -> ${file}`);
    console.log(`          expect: ${shot.note}`);
  }

  await browser.close();
  console.log(`\n${SHOTS.length} frames written to ${OUT}`);
  console.log("Check each against the 'What must be legible' column in SCRIPT.md before filming.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
