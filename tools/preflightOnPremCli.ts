#!/usr/bin/env tsx
/**
 * Operator entry point for the on-premise deployment preflight.
 *
 *   pnpm onprem:preflight -- --profile cpu --env-file deploy/on-prem/.env.onprem
 *
 * Exits non-zero on any error finding, so it can gate a release pipeline as well
 * as an install. It reads only the env file — it starts nothing and contacts
 * nothing, which is what makes it safe to run inside an air-gapped institution.
 */
import fs from "node:fs";
import { formatFindings, parseEnvFile, preflight, type ProfileName } from "./onPremPreflight";

function parseArgv(argv: string[]): { profile: ProfileName; envFile: string } {
  let profile: string | undefined;
  let envFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") profile = argv[++i];
    else if (argv[i] === "--env-file") envFile = argv[++i];
  }
  if (profile !== "cpu" && profile !== "gpu") {
    throw new Error("--profile must be 'cpu' or 'gpu'");
  }
  if (!envFile) {
    throw new Error("--env-file is required (e.g. deploy/on-prem/.env.onprem)");
  }
  return { profile, envFile };
}

function main(): void {
  let args: { profile: ProfileName; envFile: string };
  try {
    args = parseArgv(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n`);
    console.error("usage: onprem:preflight -- --profile <cpu|gpu> --env-file <path>");
    process.exit(2);
    return;
  }

  if (!fs.existsSync(args.envFile)) {
    console.error(`env file not found: ${args.envFile}`);
    process.exit(2);
    return;
  }

  const findings = preflight(args.profile, parseEnvFile(fs.readFileSync(args.envFile, "utf8")));
  const output = formatFindings(args.profile, findings);
  const hasErrors = findings.some((f) => f.severity === "error");
  if (hasErrors) console.error(output);
  else console.log(output);
  process.exit(hasErrors ? 1 : 0);
}

main();
