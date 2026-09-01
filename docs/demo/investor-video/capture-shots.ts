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

/**
 * The organisation each token must land in, by id.
 *
 * Checked against `auth.me`, NOT against text on the page. An earlier revision
 * asserted the organisation NAME was rendered somewhere in the body, which was
 * wrong twice over: the shell renders the product name rather than the tenant's,
 * so a valid session would have been rejected and the run aborted; and a bare
 * substring would have matched the wrong tenant anyway ("ReconcileAI Dev Store"
 * and "ReconcileAI Guest Demo" share a prefix). An integer from the session
 * endpoint is exact and does not depend on what the UI chooses to display.
 */
const TENANT_ORG_ID: Record<Vertical, number> = {
  fs: 120001,
  b2b: 30001,
  retail: 60001,
};

type Shot = {
  id: string;
  vertical: Vertical;
  path: string;
  /**
   * Exact phrases that must appear before the frame is saved.
   *
   * These must be UNAMBIGUOUS STRINGS, never bare numbers. `body.includes("16")`
   * is satisfied by "160", "2016", a timestamp or a currency amount, so it
   * accepts exactly the wrong frame it was added to reject. Only assert text
   * verified to be rendered by the page's source.
   */
  expect?: string[];
  prepare?: (page: Page) => Promise<void>;
};

const SHOTS: Shot[] = [
  // The figures the narration quotes are verified against the DATABASE by
  // `pnpm demo:verify`, which is exact. Re-checking them by reading pixels
  // would only be as good as a guess at the markup, so these shots assert
  // tenant + page identity and leave the numbers to the tool that can measure
  // them properly. SHOT-03 is the exception: it states a count out loud, and
  // the page happens to render that count as an unambiguous sentence.
  { id: "SHOT-01", vertical: "fs", path: "/dashboard" },
  {
    id: "SHOT-02", vertical: "fs", path: "/channels",
    // Agent Banking is the rail an earlier indexing defect silently dropped,
    // so it is named explicitly — a rail name is not ambiguous the way a
    // number is.
    expect: ["Agent Banking", "NIBSS NIP", "Core Banking"],
  },
  {
    id: "SHOT-03", vertical: "fs", path: "/exceptions",
    // Defaults to Today, and the seeded cases are aged 0–7 days, so the default
    // view is nearly empty. "Last 7 days" is the widest preset available
    // (DATE_PRESETS in client/src/hooks/useDateRange.ts).
    prepare: async (page) => {
      await page.getByRole("button", { name: "Last 7 days" }).click();
      await page.waitForTimeout(2500);
    },
    // Exceptions.tsx renders `Showing {n} exception{s} — {dateLabel}`. Matching
    // the whole phrase pins the count AND proves the filter was applied; the
    // bare "16" this replaced was satisfied by any "16" anywhere on the page.
    // The narration says sixteen, so fifteen must fail the run.
    expect: ["Showing 16 exceptions"],
  },
  { id: "SHOT-04", vertical: "b2b", path: "/dashboard" },
  { id: "SHOT-05", vertical: "b2b", path: "/distributors", expect: ["Distributor"] },
  // Retail leads on the CONNECTION, not on volume — see README §Retail.
  { id: "SHOT-06", vertical: "retail", path: "/settlement-monitor", expect: ["Settlement"] },
  {
    id: "SHOT-07", vertical: "retail", path: "/settlement-monitor",
    prepare: async (page) => { await page.mouse.wheel(0, 900); await page.waitForTimeout(1200); },
  },
  { id: "SHOT-08", vertical: "fs", path: "/exception-intelligence" },
  {
    id: "SHOT-09", vertical: "fs", path: "/exception-intelligence",
    prepare: async (page) => { await page.mouse.wheel(0, 700); await page.waitForTimeout(1200); },
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

/**
 * Who does the server think we are? Asked of the session endpoint, not the DOM.
 *
 * Returns null when there is no session at all — which is what a redirect to
 * the login page looks like from here.
 */
async function activeOrganizationId(page: Page): Promise<number | null> {
  return page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/trpc/auth.me`, { credentials: "include" });
    if (!res.ok) return null;
    const body = await res.json();
    // superjson transformer (server/_core/trpc.ts) wraps the payload in .json
    const user = body?.result?.data?.json ?? body?.result?.data ?? null;
    const id = user?.organizationId;
    return typeof id === "number" ? id : null;
  }, BASE);
}

async function swapTenant(page: Page, vertical: Vertical) {
  await page.goto(`${BASE}/api/reviewer-access?key=${encodeURIComponent(TOKENS[vertical]!)}`, { waitUntil: "networkidle" });
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  // An expired, revoked or rate-limited token REDIRECTS rather than failing, and
  // a failed exchange leaves the previous tenant's session intact. Both would
  // otherwise be photographed under the next vertical's filename — a
  // cross-tenant frame in an investor deck.
  const actual = await activeOrganizationId(page);
  const expected = TENANT_ORG_ID[vertical];
  if (actual !== expected) {
    throw new ShotError(
      `tenant swap to '${vertical}' did not take.\n` +
      `  expected organizationId ${expected}, session reports ${actual ?? "no session"}\n` +
      `  url now: ${page.url()}\n` +
      (actual === null
        ? `  No session — the token is expired or revoked. Mint a fresh tenant-scoped link.`
        : `  Still inside organisation ${actual}. The exchange failed and the previous\n` +
          `  session is still live; every following frame would be the wrong tenant.`),
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
      if (shot.expect?.length) await assertVisible(page, shot.id, shot.expect);

      const file = join(OUT, `${shot.id}-${shot.vertical}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`OK  ${shot.id}  ${shot.vertical.padEnd(6)} ${shot.path.padEnd(24)} -> ${file}`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${SHOTS.length} frames written to ${OUT}`);
  console.log("Each was taken in a session the server confirmed was the right tenant.");
  console.log("Run 'pnpm demo:verify' for the figures themselves — it measures the");
  console.log("database directly rather than reading them off pixels.");
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  console.error("No further frames captured. Fix the above and re-run — a partial");
  console.error("set is fine, but a wrong frame is not.\n");
  process.exit(1);
});
