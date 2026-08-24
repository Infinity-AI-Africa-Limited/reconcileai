import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const run = promisify(execFile);
const outputPath = resolve(process.argv[2] ?? "docs/financial-services/evidence/reconcileai_production_sbom_2026-08-24.cdx.json");
const { stdout } = await run("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], { maxBuffer: 64 * 1024 * 1024 });
const inventory = JSON.parse(stdout);
const root = Array.isArray(inventory) ? inventory[0] : inventory;
const components = new Map();

function addDependencies(dependencies = {}) {
  for (const [fallbackName, dependency] of Object.entries(dependencies)) {
    const name = dependency.name ?? dependency.from ?? fallbackName;
    const version = dependency.version ?? "unknown";
    const key = `${name}@${version}`;
    if (!components.has(key)) {
      const purlName = encodeURIComponent(name).replace(/%40/g, "@");
      components.set(key, {
        type: "library",
        name,
        version,
        purl: `pkg:npm/${purlName}@${encodeURIComponent(version)}`,
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

await writeFile(outputPath, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`Wrote ${bom.components.length} production components to ${outputPath}`);
