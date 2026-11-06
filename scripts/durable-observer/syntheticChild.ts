/** Synthetic-only artifact. Fixed fixtures; no env, files, drivers, app or transport. */
import { observeDurableStores, type ObserverDependencies } from './core';
import { serializeReport, REFUSED_REPORT } from './report';

const scenario = process.argv[2] ?? '';
let monotonic = 0;
const fixtures: ObserverDependencies = {
  database: {
    async read(id) {
      if (scenario === 'read_failure' && id === 'session.snapshot') throw new Error('PRIVATE_TEST_SENTINEL_DO_NOT_RELEASE');
      if (id.startsWith('session.')) return undefined;
      if (id.startsWith('intake.')) return { count: 0 };
      const unfinished = scenario === 'unfinished' && id === 'reconciliation_jobs.unfinished';
      return { count: unfinished ? 1 : 0, oldestAgeSeconds: unfinished ? 90 : null };
    },
    async close() {},
    drop() {},
  },
  redis: {
    async read() { return 0; },
    async scan() { return ['0', []]; },
    async close() {},
    drop() {},
  },
  clock: {
    now() { return monotonic; },
    async wait(milliseconds) { monotonic += milliseconds; },
  },
};

try {
  if (!['zero', 'unfinished', 'read_failure', 'malformed'].includes(scenario)) throw new Error('scenario_refused');
  const report = await observeDurableStores(fixtures);
  // This deliberately bad synthetic child tests screening; never a production driver payload.
  const output = scenario === 'malformed' ? JSON.stringify({ ...report, diagnostic: 'PRIVATE_TEST_SENTINEL_DO_NOT_RELEASE' }) : serializeReport(report);
  if (output === REFUSED_REPORT) throw new Error('report_refused');
  process.stdout.write(output);
} catch {
  process.exitCode = 1;
}
