/**
 * PREPARATION ONLY. No SSH, network, application, credential, filesystem, or
 * subprocess imports. A preparation ticket is not live-run authorisation.
 * The live adapter is absent pending approved authentication and exact live-run
 * authorisation. The founder has delegated the eventual operator role to Manus.
 */
import { createHash } from 'node:crypto';
import { screenOutput } from './report.mjs';

export const SPEC = Object.freeze({
  schema: 'reconcileai_controlled_preflight_preparation_v1',
  checkedMain: '4efaac2a1e4d35f9aaa448b2daba4652e7e58dee',
  branchHead: 'b3b323f759dbe205653847af3ad424ce0e93c95f',
  probeCommit: '6c9243f20837ca8ef13c9edacdd39e4234461774',
  probeSha256: '9cf0ee931d3643a4b2367e985d2d779d8569a7eea72dffb5c887fb5ee4a31aab',
  routineCommit: '94d0cd1b2a92d76fe16f7592c664e0c4319ac19f',
  routineSha256: 'a01f2938dceb5016f638fb5855445996cf89ab72c4e65d47392399fff58cdb00',
  samples: 3,
  intervalSeconds: 60,
  probeBudgetSeconds: 300,
  wrapperLimitSeconds: 360,
  wrapperKillAfterSeconds: 10,
  appDirectory: '/app',
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{40}$/;
const fail = code => Object.freeze({ schema: SPEC.schema, status: 'refused', code, hold: true });

/** Snapshot only exact plain data properties. Never invoke a getter. */
function snapshot(value, keys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.length || !keys.every(key => Object.hasOwn(descriptors, key)
        && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable)) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
  } catch { return null; }
}

// Source-compatible copy of the immutable probe's placeholder predicate. No
// probe import: this check cannot touch an application environment or socket.
const placeholders = new Set([
  '123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426655440000',
  '550e8400-e29b-41d4-a716-446655440000', 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  '6ba7b810-9dad-11d1-80b4-00c04fd430c8', '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
  '6ba7b812-9dad-11d1-80b4-00c04fd430c8', '6ba7b814-9dad-11d1-80b4-00c04fd430c8',
  'da39a3ee5e6b4b0d3255bfef95601890afd80709', '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
]);
function isPlaceholder(value) {
  if (placeholders.has(value)) return true;
  const hex = value.replace(/-/g, '');
  if (new Set(hex).size < 6) return true;
  for (let period = 1; period <= hex.length / 2; period += 1) {
    let repeats = true;
    for (let i = period; i < hex.length && repeats; i += 1) repeats = hex[i] === hex[i - period];
    if (repeats) return true;
  }
  let up = 1; let down = 1;
  for (let i = 1; i < hex.length; i += 1) {
    const step = Number.parseInt(hex[i], 16) - Number.parseInt(hex[i - 1], 16);
    up = step === 1 ? up + 1 : 1;
    down = step === -1 ? down + 1 : 1;
    if (up >= 8 || down >= 8) return true;
  }
  return false;
}

export function checkTarget(request) {
  const captured = snapshot(request, ['deployment_id', 'commit_sha']);
  if (captured === null) return fail('request_shape_refused');
  const { deployment_id, commit_sha } = captured;
  if (typeof deployment_id !== 'string' || !uuid.test(deployment_id)) return fail('deployment_identity_refused');
  if (isPlaceholder(deployment_id)) return fail('deployment_placeholder_refused');
  if (typeof commit_sha !== 'string' || !sha.test(commit_sha)) return fail('commit_identity_refused');
  if (isPlaceholder(commit_sha)) return fail('commit_placeholder_refused');
  if (commit_sha !== SPEC.checkedMain) return fail('coverage_revision_changed');
  return Object.freeze({ status: 'validated', deployment_id, commit_sha });
}

export function verifyArtifacts(probeBytes, routineBytes) {
  if (!Buffer.isBuffer(probeBytes) || !Buffer.isBuffer(routineBytes)
      || probeBytes.length === 0 || probeBytes.length > 256 * 1024
      || routineBytes.length === 0 || routineBytes.length > 32 * 1024) return fail('artifact_shape_refused');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  if (digest(probeBytes) !== SPEC.probeSha256 || digest(routineBytes) !== SPEC.routineSha256) return fail('artifact_checksum_refused');
  return Object.freeze({ status: 'validated', code: 'pinned_artifacts_verified' });
}

export function preparePlan(request, probeBytes, routineBytes) {
  const target = checkTarget(request);
  if (target.status !== 'validated') return target;
  const artifacts = verifyArtifacts(probeBytes, routineBytes);
  if (artifacts.status !== 'validated') return artifacts;
  return Object.freeze({
    schema: SPEC.schema, status: 'prepared_not_authorised', hold: true,
    deployment_id: target.deployment_id, commit_sha: target.commit_sha,
    probe_commit: SPEC.probeCommit, probe_sha256: SPEC.probeSha256,
    routine_commit: SPEC.routineCommit, routine_sha256: SPEC.routineSha256,
    operation: 'single_pinned_workload_diagnostic', samples: SPEC.samples,
    interval_seconds: SPEC.intervalSeconds, probe_budget_seconds: SPEC.probeBudgetSeconds,
    wrapper_timeout_seconds: SPEC.wrapperLimitSeconds, wrapper_kill_after_seconds: SPEC.wrapperKillAfterSeconds,
    live_adapter: 'absent', authentication: 'not_configured', operator_approval: 'not_granted',
    database_write_protection: 'statement_guard_only', production_cleanup: 'not_performed',
  });
}

/** Builds only the reviewed remote input bytes; it never executes them. */
export function buildRemoteInput(request, probeBytes, routineBytes) {
  const plan = preparePlan(request, probeBytes, routineBytes);
  if (plan.status !== 'prepared_not_authorised') return plan;
  const routine = routineBytes.toString('utf8');
  return Object.freeze({ status: 'prepared_not_authorised', hold: true, remote_command: '/bin/sh -s',
    stdin: `${routine}\nreconcileai_preflight ${plan.deployment_id} ${plan.commit_sha}\n`,
  });
}

/** No live bypass, override, callback, or authentication argument exists. */
export function requestLiveRun() { return fail('live_adapter_not_approved'); }

/** Synthetic lifecycle only. No IO, actual provider revocation or cleanup. */
export function createSyntheticSession(request, probeBytes, routineBytes, createdAtMs) {
  const prepared = preparePlan(request, probeBytes, routineBytes);
  if (prepared.status !== 'prepared_not_authorised') return prepared;
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0
      || createdAtMs > Number.MAX_SAFE_INTEGER - 900000) return fail('clock_refused');
  let used = false; let revoked = false;
  const expiresAtMs = createdAtMs + 900000;
  return Object.freeze({
    status: 'synthetic_session', plan: prepared,
    revoke() { revoked = true; return fail('synthetic_session_revoked'); },
    simulate(transcript, nowMs) {
      if (revoked) return fail('synthetic_session_revoked');
      if (used) return fail('synthetic_session_already_consumed');
      if (!Number.isSafeInteger(nowMs) || nowMs < createdAtMs || nowMs >= expiresAtMs) return fail('synthetic_session_expired');
      used = true; // Consume before screening; failures never silently retry.
      const captured = snapshot(transcript, ['stdout', 'stderr', 'exitCode', 'elapsedMs']);
      if (captured === null || !Number.isSafeInteger(captured.elapsedMs) || captured.elapsedMs < 0) return fail('transcript_shape_refused');
      if (captured.elapsedMs > (SPEC.wrapperLimitSeconds + SPEC.wrapperKillAfterSeconds) * 1000) return fail('synthetic_budget_exhausted');
      const screened = screenOutput(captured.stdout, captured.stderr, captured.exitCode);
      return Object.freeze({ ...screened, mode: 'synthetic_only', hold: true, production_connections: 0,
        remote_cleanup: 'not_proven', provider_access_revocation: 'not_performed',
      });
    },
  });
}
