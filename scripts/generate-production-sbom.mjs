import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const run = promisify(execFile);
const outputPath = resolve(process.argv[2] ?? "docs/financial-services/evidence/reconcileai_production_sbom_2026-08-24.cdx.json");
/**
 * pnpm is `pnpm.cmd` on Windows, and `execFile` does not consult PATHEXT — so a
 * bare "pnpm" dies there with ENOENT. This pack has to be reproducible by a
 * bank's auditor on whatever machine they have, so the platform difference is
 * handled rather than assumed away.
 */
const IS_WINDOWS = process.platform === "win32";
const PNPM = IS_WINDOWS ? "pnpm.cmd" : "pnpm";

/**
 * Node 22 refuses to spawn a `.cmd` without a shell (the CVE-2024-27980
 * mitigation), so Windows needs `shell: true` — which is safe here only because
 * every argument below is a hard-coded literal. Never interpolate input into
 * this call.
 */
const SPAWN_OPTIONS = { maxBuffer: 64 * 1024 * 1024, shell: IS_WINDOWS };

/** A half-written or empty SBOM presented as evidence is worse than none. */
function refuse(reason) {
  console.error(`${reason}\nNo SBOM was written.`);
  process.exit(1);
}

let stdout;
try {
  ({ stdout } = await run(PNPM, ["list", "--prod", "--depth", "Infinity", "--json"], SPAWN_OPTIONS));
} catch (error) {
  refuse(`Could not run \`${PNPM} list --prod\`: ${error?.message ?? error}`);
}

let inventory;
try {
  inventory = JSON.parse(stdout);
} catch (error) {
  refuse(`\`${PNPM} list --prod --json\` did not return JSON: ${error?.message ?? error}`);
}

const root = Array.isArray(inventory) ? inventory[0] : inventory;
if (!root || typeof root !== "object") {
  refuse("`pnpm list --prod --json` returned no root package.");
}

const components = new Map();

/**
 * package-url identity for an npm component.
 *
 * A SCOPED package's scope is the purl NAMESPACE, not part of the name:
 *
 *   correct    pkg:npm/%40antfu/install-pkg@1.1.0
 *   wrong      pkg:npm/@antfu%2Finstall-pkg@1.1.0
 *
 * The wrong form encodes the separating slash, collapsing namespace and name
 * into one segment. CycloneDX and package-url consumers then reject the
 * component or fail to match it — which in a bank-facing SBOM means a scoped
 * dependency silently drops out of vulnerability correlation. Roughly a third
 * of this tree's production components are scoped, so this is not a rare edge.
 *
 * Each segment is percent-encoded on its own; the slash between them stays
 * literal. `@` inside the namespace must stay encoded as %40 — unescaping it
 * (as the previous version did) is what produced the broken form.
 */
function npmPurlParts(name) {
  const scoped = name.startsWith("@");
  if (!scoped) return { namespace: null, bare: name };
  const slash = name.indexOf("/");
  // A leading @ with no slash is not a valid scope; treat it as a bare name
  // rather than inventing an empty namespace.
  if (slash === -1) return { namespace: null, bare: name };
  return { namespace: name.slice(0, slash), bare: name.slice(slash + 1) };
}

function npmPurl(name, version) {
  const { namespace, bare } = npmPurlParts(name);
  const path = namespace
    ? `${encodeURIComponent(namespace)}/${encodeURIComponent(bare)}`
    : encodeURIComponent(bare);
  return `pkg:npm/${path}@${encodeURIComponent(version)}`;
}

function addDependencies(dependencies = {}) {
  for (const [fallbackName, dependency] of Object.entries(dependencies)) {
    const name = dependency.name ?? dependency.from ?? fallbackName;
    const version = dependency.version ?? "unknown";
    const key = `${name}@${version}`;
    if (!components.has(key)) {
      components.set(key, {
        type: "library",
        name,
        ...(npmPurlParts(name).namespace ? { group: npmPurlParts(name).namespace } : {}),
        version,
        purl: npmPurl(name, version),
        externalReferences: dependency.resolved
          ? [{ type: "distribution", url: dependency.resolved }]
          : undefined,
      });
    }
    addDependencies(dependency.dependencies);
  }
}

addDependencies(root.dependencies);

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    component: {
      type: "application",
      name: root.name ?? "reconcileai",
      version: root.version ?? "unknown",
    },
    properties: [
      { name: "reconcileai:source", value: "pnpm list --prod --depth Infinity" },
      { name: "reconcileai:scope", value: "production dependencies only" },
    ],
  },
  components: [...components.values()].sort((left, right) => left.purl.localeCompare(right.purl)),
};

// Zero components cannot be right for this project, and an empty SBOM that
// looks well-formed is exactly the kind of evidence nobody re-checks.
if (bom.components.length === 0) {
  refuse("Resolved 0 production components — check that dependencies are installed.");
}

await writeFile(outputPath, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`Wrote ${bom.components.length} production components to ${outputPath}`);
