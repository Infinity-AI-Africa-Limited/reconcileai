import { describe, it, expect } from 'vitest';
import { prepareSyntheticBinding, type BindingApproval, type IndependentTargetFacts } from './binding';
import { SOURCE_PIN } from './catalogue';

const target = 'b815c85e-f684-4aa3-a1fa-42d1490f1b36';
const observer = 'd4eb9df7-218c-4b41-aaf8-fd23ef3a1dfb';
const deployment = '757a3c0b-fd72-486f-89b9-a1f6c9086fd2';
const approval: BindingApproval = { targetServiceId: target, targetDeploymentId: deployment, targetSource: SOURCE_PIN,
  observerServiceId: observer, observerArtifact: 'a'.repeat(64), dbReferenceSourceServiceId: target,
  redisReferenceSourceServiceId: target, validUntilMs: 120_000 };
const facts: IndependentTargetFacts = { serviceId: target, deploymentId: deployment, source: SOURCE_PIN, sampledAtMs: 10_000 };

describe('when only synthetic target and approval facts are supplied', () => {
  it('should capture matching facts without enabling a live connection or lifting hold', () => {
    expect(prepareSyntheticBinding(approval, facts, 20_000)).toEqual({ execution: 'synthetic_only', liveEnabled: false, hold: true });
  });
  it.each([
    { observerServiceId: target }, { dbReferenceSourceServiceId: observer }, { redisReferenceSourceServiceId: observer },
    { targetDeploymentId: observer }, { targetSource: 'f'.repeat(40) }, { observerArtifact: 'tag-not-a-digest' },
    { validUntilMs: 20_000 }, { validUntilMs: 1_000_000 },
  ])('should refuse ambiguous, changed or expired approval bindings', change => {
    expect(() => prepareSyntheticBinding({ ...approval, ...change }, facts, 20_000)).toThrow('observer_binding_refused');
  });
  it.each([
    { serviceId: observer }, { deploymentId: observer }, { source: 'f'.repeat(40) }, { sampledAtMs: 30_000 },
  ])('should reject target facts substituted from the observer or a newer deployment', change => {
    expect(() => prepareSyntheticBinding(approval, { ...facts, ...change }, 20_000)).toThrow('observer_binding_refused');
  });
  it('should reject stale facts and noncanonical times', () => {
    expect(() => prepareSyntheticBinding({ ...approval, validUntilMs: 600_000 }, facts, 500_000)).toThrow('observer_binding_refused');
    for (const time of [-1, NaN, Infinity, 0.1]) expect(() => prepareSyntheticBinding(approval, facts, time)).toThrow('observer_binding_refused');
  });
  it('should reject extra credential fields and never evaluate an accessor or proxy', () => {
    expect(() => prepareSyntheticBinding({ ...approval, DATABASE_URL: 'PRIVATE_TEST_SENTINEL_DO_NOT_RELEASE' }, facts, 20_000)).toThrow('observer_binding_refused');
    let reads = 0;
    const getter = Object.defineProperty({ ...approval }, 'targetServiceId', { enumerable: true, get() { reads += 1; return target; } });
    expect(() => prepareSyntheticBinding(getter, facts, 20_000)).toThrow('observer_binding_refused');
    const proxy = new Proxy(approval, { ownKeys() { reads += 1; return []; } });
    expect(() => prepareSyntheticBinding(proxy, facts, 20_000)).toThrow('observer_binding_refused');
    expect(reads).toBe(0);
  });
});
