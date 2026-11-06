import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifact = path.join(root, 'dist/durable-observer');
const SENTINEL = 'PRIVATE_TEST_SENTINEL_DO_NOT_RELEASE';
const cleanEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', LANG: 'C.UTF-8' };
let scratch = '';
function run(args: string[], folder = artifact) {
  return spawnSync(process.execPath, ['--no-addons', path.join(folder, 'launch.mjs'), ...args], {
    cwd: folder, env: { ...cleanEnv, DATABASE_URL: SENTINEL, REDIS_URL: SENTINEL, DIRECT_LLM_API_KEY: SENTINEL },
    encoding: 'utf8', timeout: 15_000, maxBuffer: 150_000,
  });
}
function copyArtifact(): string {
  const target = mkdtempSync(path.join(scratch, 'case-'));
  cpSync(artifact, target, { recursive: true });
  return target;
}
function reportOf(text: string): Record<string, unknown> {
  const result: unknown = JSON.parse(text);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid_test_report');
  return result as Record<string, unknown>;
}
beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'durable-observer-artifact-'));
  const built = spawnSync(process.execPath, [path.join(root, 'scripts/durable-observer/build.mjs')], { cwd: root, env: cleanEnv, encoding: 'utf8', timeout: 30_000 });
  expect(built.status).toBe(0);
  expect(built.stderr).toBe('');
}, 35_000);
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

describe('when the separate artifact receives an execution request', () => {
  it.each([[], ['--live'], ['--synthetic=unknown'], ['--synthetic=zero', '--live'], [SENTINEL]].map(args => ({ args })))('should refuse nonliteral synthetic-only arguments without importing a driver', ({ args }) => {
    const output = run(args);
    expect(output.status).toBe(2);
    expect(output.stderr).toBe('');
    expect(output.stdout).not.toContain(SENTINEL);
    expect(reportOf(output.stdout)).toMatchObject({ execution: 'refused', hold: true, code: 'live_execution_unavailable' });
  });
  it.each([
    ['zero', 'zero_observed_not_proof'], ['unfinished', 'no_go_unfinished_work'], ['read_failure', 'no_go_incomplete_evidence'],
  ])('should return a screened HOLD report for the fixed scenario %s', (scenario, verdict) => {
    const output = run([`--synthetic=${scenario}`]);
    expect(output.status).toBe(0);
    expect(output.stderr).toBe('');
    expect(output.stdout).not.toContain(SENTINEL);
    expect(reportOf(output.stdout)).toMatchObject({ execution: 'synthetic_only', hold: true, databaseControl: 'statement_guard_only', verdict });
  });
  it('should refuse the deliberately malformed child report without releasing its diagnostic', () => {
    const output = run(['--synthetic=malformed']);
    expect(output.status).toBe(1);
    expect(output.stderr).toBe('');
    expect(output.stdout).not.toContain(SENTINEL);
    expect(reportOf(output.stdout)).toMatchObject({ hold: true, code: 'synthetic_artifact_failed' });
  });
});

describe('when an artifact child fails outside the observer core', () => {
  it.each([
    `process.stderr.write('${SENTINEL}'); throw new Error('${SENTINEL}');`,
    `process.stdout.write('${SENTINEL}'); process.exitCode=0;`,
    `process.stdout.write('x'.repeat(70000));`,
  ])('should suppress raw stderr and invalid or oversized stdout', source => {
    const folder = copyArtifact();
    writeFileSync(path.join(folder, 'child.mjs'), source + '\n');
    const output = run(['--synthetic=zero'], folder);
    expect(output.status).toBe(1);
    expect(output.stderr).toBe('');
    expect(output.stdout).not.toContain(SENTINEL);
    expect(output.stdout.length).toBeLessThan(300);
  });
  it('should remove inherited connection variables and runtime injection options from the child', () => {
    const folder = copyArtifact();
    const original = readFileSync(path.join(folder, 'child.mjs'), 'utf8');
    writeFileSync(path.join(folder, 'child.mjs'), `if (process.env.DATABASE_URL || process.env.REDIS_URL || process.env.DIRECT_LLM_API_KEY || process.env.NODE_OPTIONS) throw new Error('${SENTINEL}');\n` + original);
    const output = run(['--synthetic=zero'], folder);
    expect(output.status).toBe(0);
    expect(output.stdout).not.toContain(SENTINEL);
  });
  it('should stop its own child on a termination signal and never release partial output', async () => {
    const folder = copyArtifact();
    writeFileSync(path.join(folder, 'child.mjs'), `process.stdout.write('${SENTINEL}'); setInterval(()=>{},1000);\n`);
    const child = spawn(process.execPath, [path.join(folder, 'launch.mjs'), '--synthetic=zero'], { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exit = new Promise<number | null>(resolve => child.once('close', resolve));
    const signal = setTimeout(() => { child.kill('SIGTERM'); }, 300);
    const kill = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
    try { expect(await exit).toBe(1); } finally { clearTimeout(signal); clearTimeout(kill); }
    expect(stderr).toBe('');
    expect(stdout).not.toContain(SENTINEL);
    expect(reportOf(stdout)).toMatchObject({ hold: true, code: 'synthetic_artifact_failed' });
  });
});

describe('when the isolated artifact is built', () => {
  it('should pin every output byte while excluding packages, app modules and socket APIs', () => {
    const raw: unknown = JSON.parse(readFileSync(path.join(artifact, 'manifest.json'), 'utf8'));
    expect(raw).toMatchObject({ execution: 'synthetic_only', liveEnabled: false });
    const manifest = raw as { files: Record<string, string> };
    expect(Object.keys(manifest.files)).toEqual(['launch.mjs', 'child.mjs', 'screen.mjs']);
    for (const [file, hash] of Object.entries(manifest.files)) {
      const bytes = readFileSync(path.join(artifact, file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
      expect(bytes.toString()).not.toMatch(/mysql2|ioredis|bullmq|dotenv|node:(net|tls|http)|server\/db|server\/_core\/index/);
    }
  });
  it('should keep the image template separate and nonpublic with no application build or variable reference', () => {
    const docker = readFileSync(path.join(root, 'deploy/durable-observer/Dockerfile.preparation'), 'utf8');
    expect(docker).toContain('ARG VERIFIED_NODE_IMAGE');
    expect(docker).toContain('USER node');
    expect(docker).not.toMatch(/^EXPOSE|pnpm|DATABASE_URL|REDIS_URL|db:migrate/m);
    expect(docker).toContain('COPY --chown=node:node launch.mjs child.mjs screen.mjs manifest.json');
  });
});
