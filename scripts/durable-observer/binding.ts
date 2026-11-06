import { types } from 'node:util';
import { SOURCE_PIN } from './catalogue';

export interface BindingApproval {
  targetServiceId: string;
  targetDeploymentId: string;
  targetSource: string;
  observerServiceId: string;
  observerArtifact: string;
  dbReferenceSourceServiceId: string;
  redisReferenceSourceServiceId: string;
  validUntilMs: number;
}
export interface IndependentTargetFacts {
  serviceId: string;
  deploymentId: string;
  source: string;
  sampledAtMs: number;
}
const APPROVAL_KEYS = ['targetServiceId', 'targetDeploymentId', 'targetSource', 'observerServiceId', 'observerArtifact', 'dbReferenceSourceServiceId', 'redisReferenceSourceServiceId', 'validUntilMs'] as const;
const FACT_KEYS = ['serviceId', 'deploymentId', 'source', 'sampledAtMs'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refused = (): never => { throw new Error('observer_binding_refused'); };
function plain(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return refused();
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return refused();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return refused();
    captured[key] = descriptor.value as unknown;
  }
  return captured;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value) || /^0{8}-/.test(value)) return refused();
  return value;
}
function milliseconds(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : refused();
}

/** Equality/recency guard only. No control-plane access, authentication, env lookup
 * or trust in observer-local metadata. Caller facts are NOT provider attestation.
 * This preparation always returns liveEnabled:false regardless of valid bindings.
 */
export function prepareSyntheticBinding(approvalInput: unknown, factsInput: unknown, nowMs: number): Readonly<{ execution: 'synthetic_only'; liveEnabled: false; hold: true }> {
  const approval = plain(approvalInput, APPROVAL_KEYS);
  const facts = plain(factsInput, FACT_KEYS);
  const now = milliseconds(nowMs);
  const target = uuid(approval.targetServiceId);
  if (uuid(approval.observerServiceId) === target || uuid(approval.dbReferenceSourceServiceId) !== target || uuid(approval.redisReferenceSourceServiceId) !== target) return refused();
  if (uuid(facts.serviceId) !== target || uuid(facts.deploymentId) !== uuid(approval.targetDeploymentId)) return refused();
  if (approval.targetSource !== SOURCE_PIN || facts.source !== SOURCE_PIN) return refused();
  if (typeof approval.observerArtifact !== 'string' || !/^[0-9a-f]{64}$/.test(approval.observerArtifact)) return refused();
  const sampled = milliseconds(facts.sampledAtMs);
  const expiry = milliseconds(approval.validUntilMs);
  if (sampled > now || now - sampled > 300_000 || expiry <= now || expiry - now > 900_000) return refused();
  return Object.freeze({ execution: 'synthetic_only', liveEnabled: false, hold: true });
}
