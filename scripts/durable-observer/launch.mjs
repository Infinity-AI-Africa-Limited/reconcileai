/** Synthetic preparation artifact only. No live transport, credentials or application imports. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REFUSED = '{"schema":"reconcileai_observer_launch_v1","execution":"refused","hold":true,"code":"live_execution_unavailable"}\n';
const FAILED = '{"schema":"reconcileai_observer_launch_v1","execution":"refused","hold":true,"code":"synthetic_artifact_failed"}\n';
const SCENARIOS = new Set(['zero', 'unfinished', 'read_failure', 'malformed']);

export async function launch(args, runtime = process) {
  // Literal fixed argument language. Never inspect a connection setting or import an adapter.
  if (args.length !== 1 || !args[0].startsWith('--synthetic=') || !SCENARIOS.has(args[0].slice(12))) {
    runtime.stdout.write(REFUSED);
    return 2;
  }
  try {
    const { screenReport } = await import('./screen.mjs');
    const child = spawn(process.execPath, ['--no-addons', fileURLToPath(new URL('./child.mjs', import.meta.url)), args[0].slice(12)], {
      env: { NODE_ENV: 'test', LANG: 'C.UTF-8', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let bytes = 0;
    const chunks = [];
    let invalid = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10_000);
    const stop = () => { invalid = true; child.kill('SIGKILL'); };
    runtime.once('SIGTERM', stop);
    runtime.once('SIGINT', stop);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65_536) { invalid = true; child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    const code = await new Promise(resolve => {
      child.once('error', () => { invalid = true; resolve(null); });
      child.once('close', resolve);
    });
    clearTimeout(timer);
    runtime.removeListener('SIGTERM', stop);
    runtime.removeListener('SIGINT', stop);
    if (invalid || timedOut || code !== 0) throw new Error('fixed_failure');
    const output = screenReport(Buffer.concat(chunks).toString('utf8'));
    runtime.stdout.write(output + '\n');
    return 0;
  } catch {
    runtime.stdout.write(FAILED);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  launch(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.stdout.write(FAILED); process.exitCode = 1; });
}
