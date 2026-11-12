/**
 * The deploy recipe lives in the Railway service settings, not in this
 * repository (CLAUDE.md §12, docs/DEPLOYMENT_RAILWAY.md). Nothing here can read
 * those settings, but the repository can still change the build behind their
 * back. These checks refuse the files and dependencies that would:
 *
 *   - a root Dockerfile. Railway always builds with one when it exists, so it
 *     would replace the Railpack recipe without anyone touching the settings;
 *   - railway.json / railway.toml. Railway stops reading them on 1 December
 *     2026. Before then one would override the settings key by key; after, it
 *     would look authoritative and change nothing;
 *   - railpack.json / nixpacks.toml, builder config files. Railpack reads the
 *     first, so it would change the build outside the recorded recipe;
 *   - pnpm as a project dependency. Railpack's image puts /app/node_modules/.bin
 *     first on PATH, so that copy runs instead of the pinned packageManager
 *     version, then fetches the pinned one from the npm registry on every
 *     deploy and start. The Railpack rehearsal found exactly this (#236).
 *
 * Changing any of these on purpose is fine: update the recipe in CLAUDE.md §12
 * and docs/DEPLOYMENT_RAILWAY.md, and this test, in the same change.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");

type PackageJson = {
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as PackageJson;

const BUILD_CHANGING_ROOT_FILES = [
  "Dockerfile",
  "railway.json",
  "railway.toml",
  "railpack.json",
  "nixpacks.toml",
];

describe("when the repository root is read", () => {
  it.each(BUILD_CHANGING_ROOT_FILES)(
    "should hold no %s, which would change the build outside the recorded recipe",
    (file) => {
      expect(fs.existsSync(path.join(ROOT, file))).toBe(false);
    },
  );
});

describe("when package.json is read", () => {
  it("should not list pnpm itself as a dependency of any kind", () => {
    const sections = {
      dependencies: pkg.dependencies,
      devDependencies: pkg.devDependencies,
      optionalDependencies: pkg.optionalDependencies,
      peerDependencies: pkg.peerDependencies,
    };
    const listing = Object.entries(sections)
      .filter(([, deps]) => deps !== undefined && Object.hasOwn(deps, "pnpm"))
      .map(([name]) => name);
    expect(listing).toEqual([]);
  });

  it("should pin pnpm to one exact version with its integrity hash", () => {
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  });
});

describe("when Railpack looks for the Node version", () => {
  it("should find one major version in .nvmrc", () => {
    // Without it, Railpack falls back to the newest LTS rather than the Node 22
    // production runs.
    const nvmrc = fs.readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim();
    expect(nvmrc).toMatch(/^\d+$/);
  });
});
