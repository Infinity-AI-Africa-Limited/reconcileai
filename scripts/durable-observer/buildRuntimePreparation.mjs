import { build } from "esbuild";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  copyFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const digest =
  "9cf0ee931d3643a4b2367e985d2d779d8569a7eea72dffb5c887fb5ee4a31aab";

/** Preparation library ONLY. Vendor remains a distinct module, never an esbuild
 * bundle entry: its direct-entry check must not become true in a bundled job. */
export async function buildRuntimePreparation(outputDirectory) {
  const output = resolve(outputDirectory);
  const bytes = await readFile(
    join(source, "vendor/production-workload-preflight.mjs")
  );
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    throw new Error("runtime_build_refused");
  await mkdir(output, { recursive: true });
  const result = await build({
    stdin: {
      contents:
        'export { openRuntimeReaders } from "./runtimeAdapters"; export { inspectPlatformIdentity } from "./platformIdentity";',
      resolveDir: source,
      sourcefile: "runtimeLibrary.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: join(output, "runtimeLibrary.mjs"),
    external: ["./vendor/production-workload-preflight.mjs"],
    metafile: true,
    logLevel: "silent",
  });
  const compiled = await readFile(join(output, "runtimeLibrary.mjs"), "utf8");
  if (
    !compiled.includes("./vendor/production-workload-preflight.mjs") ||
    Object.keys(result.metafile.inputs).some(input =>
      input.endsWith("production-workload-preflight.mjs")
    )
  )
    throw new Error("runtime_build_refused");
  await mkdir(join(output, "vendor"), { recursive: true });
  for (const name of [
    "production-workload-preflight.mjs",
    "provenance.json",
    "PROVENANCE.md",
  ])
    await copyFile(join(source, "vendor", name), join(output, "vendor", name));
  await writeFile(
    join(output, "refuseLive.mjs"),
    'process.stdout.write("{\\"schema\\":\\"observer_runtime_preparation\\",\\"hold\\":true,\\"liveEnabled\\":false}\\n");\nprocess.exitCode=2;\n'
  );
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(
      {
        schema: "observer_runtime_preparation",
        liveEnabled: false,
        hold: true,
        probeSha256: digest,
        vendorKeptSeparate: true,
        entrypoint: "refuseLive.mjs",
        blockers: [
          "secure_connector_unconfigured",
          "source_reference_unverified",
          "deployed_artifact_unverified",
          "runtime_image_unbuilt",
          "owner_live_approval_absent",
        ],
      },
      null,
      2
    ) + "\n"
  );
  return { hold: true, liveEnabled: false, probeSha256: digest };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let output;
  try {
    if (process.argv.length !== 2) throw new Error("runtime_build_refused");
    output = await mkdtemp(join(tmpdir(), "observer-runtime-preparation-"));
    await buildRuntimePreparation(output);
    process.stdout.write("runtime_preparation_build_verified\n");
  } catch {
    process.stderr.write("runtime_build_refused\n");
    process.exitCode = 2;
  } finally {
    if (output) await rm(output, { recursive: true, force: true });
  }
}
