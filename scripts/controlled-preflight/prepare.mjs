/** Offline preparation CLI. No authentication, subprocess, network, or dotenv. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { preparePlan, requestLiveRun, SPEC } from './controller.mjs';

export function main(args, write = value => process.stdout.write(value)) {
  const emit = (value, code) => { write(`${JSON.stringify(value)}\n`); return code; };
  if (args.includes('--live')) return emit(requestLiveRun(), 4);
  if (args.length !== 3 || args[0] !== '--prepare') return emit({ schema: SPEC.schema, status: 'refused', code: 'usage_refused', hold: true }, 2);
  try {
    const probe = readFileSync(new URL('./pins/probe.source.txt', import.meta.url));
    const routine = readFileSync(new URL('./pins/routine.source.txt', import.meta.url));
    const plan = preparePlan({deployment_id: args[1], commit_sha: args[2]}, probe, routine);
    return emit(plan, plan.status === 'prepared_not_authorised' ? 0 : 4);
  } catch {
    return emit({ schema: SPEC.schema, status: 'refused', code: 'preparation_failed', hold: true }, 3);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch { process.exitCode = 3; }
}
