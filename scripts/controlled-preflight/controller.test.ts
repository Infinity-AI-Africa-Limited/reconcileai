import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SPEC, checkTarget, verifyArtifacts, preparePlan, buildRemoteInput, requestLiveRun, createSyntheticSession } from './controller.mjs';
import { main } from './prepare.mjs';
import { syntheticOutput } from './synthetic-fixture';

// These identifiers are synthetic correlation values, not production targets.
const target = {deployment_id:'c8a42f17-6b93-4de0-915a-f0d2e67b8a49',commit_sha:SPEC.checkedMain};
const probe = readFileSync(new URL('./pins/probe.source.txt', import.meta.url));
const routine = readFileSync(new URL('./pins/routine.source.txt', import.meta.url));
const now = 1700000000000;
const failure = {stdout:JSON.stringify({schema:'reconcileai_workload_preflight_v2',error:'identity_commit_mismatch'})+'\n',stderr:'',exitCode:4,elapsedMs:1};
function session() {
  const value = createSyntheticSession(target,probe,routine,now);
  if (value.status !== 'synthetic_session') throw new Error('Synthetic fixture setup failed');
  return value;
}

describe('when the attached immutable files are supplied', () => {
  it('should validate both exact hashes without executing their contents', () => {
    expect(verifyArtifacts(probe,routine)).toEqual({status:'validated',code:'pinned_artifacts_verified'});
  });
  it('should prepare a plan that explicitly grants no live access', () => {
    expect(preparePlan(target,probe,routine)).toMatchObject({status:'prepared_not_authorised',hold:true,live_adapter:'absent',authentication:'not_configured',operator_approval:'not_granted',samples:3,interval_seconds:60,probe_budget_seconds:300,wrapper_timeout_seconds:360,wrapper_kill_after_seconds:10,database_write_protection:'statement_guard_only'});
  });
  it('should construct only the exact wrapper and fixed invocation with no shell override', () => {
    const value=buildRemoteInput(target,probe,routine);
    if (value.status!=='prepared_not_authorised') throw new Error('Synthetic fixture setup failed');
    expect(value.remote_command).toBe('/bin/sh -s');
    expect(value.stdin).toBe(routine.toString('utf8')+'\nreconcileai_preflight '+target.deployment_id+' '+target.commit_sha+'\n');
    expect(value.hold).toBe(true);
  });
  it.each(['probe','routine'])('should refuse changed %s bytes', artifact => {
    const changed=Buffer.from(artifact==='probe'?probe:routine);changed[0]^=1;
    expect(verifyArtifacts(artifact==='probe'?changed:probe,artifact==='routine'?changed:routine)).toMatchObject({code:'artifact_checksum_refused',hold:true});
  });
  it.each([null,'SYNTHETIC',Buffer.alloc(0),Buffer.alloc(256*1024+1)])('should refuse missing or oversized artifact input', value => {
    expect(verifyArtifacts(value,routine)).toMatchObject({status:'refused',code:'artifact_shape_refused'});
  });
});

describe('when a target or request tries to change the approved plan', () => {
  it.each([
    {...target,command:'SYNTHETIC_UNAPPROVED_COMMAND'},
    {...target,app_dir:'/tmp/SYNTHETIC'},
    {...target,budget:999},
    {...target,secret:'SYNTHETIC_ONLY'},
    [],null,{deployment_id:target.deployment_id},
  ])('should refuse every additional or missing field without echoing it', request => {
    const result=checkTarget(request);
    expect(result).toMatchObject({status:'refused',code:'request_shape_refused',hold:true});
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });
  it.each(['11111111','YOUR-DEPLOYMENT-ID','00000000-0000-0000-0000-000000000000',target.deployment_id+'; echo SYNTHETIC','../SYNTHETIC'])('should refuse malformed or shell-bearing deployment identities', deployment_id => {
    expect(checkTarget({...target,deployment_id})).toMatchObject({status:'refused',hold:true});
  });
  it.each(['SHORT','a'.repeat(40),SPEC.checkedMain+'\n','YOUR-COMMIT-SHA'])('should refuse changed coverage or malformed commits', commit_sha => {
    expect(checkTarget({...target,commit_sha})).toMatchObject({status:'refused',hold:true});
  });
  it('should refuse live execution regardless of supplied approval-like fields', () => {
    expect(requestLiveRun({approved:true,transport:'SYNTHETIC',override:true})).toMatchObject({code:'live_adapter_not_approved',hold:true});
  });
  it('should refuse accessor identities without invoking their getters', () => {
    let calls=0;
    const request={get deployment_id(){calls+=1;return calls<4?target.deployment_id:'INVALID; printf SYNTHETIC';},commit_sha:target.commit_sha};
    expect(buildRemoteInput(request,probe,routine)).toMatchObject({status:'refused',code:'request_shape_refused'});
    expect(calls).toBe(0);
  });
  it.each([
    '123e4567-e89b-12d3-a456-426614174000','123e4567-e89b-12d3-a456-426655440000',
    '550e8400-e29b-41d4-a716-446655440000','f47ac10b-58cc-4372-a567-0e02b2c3d479',
    '6ba7b810-9dad-11d1-80b4-00c04fd430c8','6ba7b811-9dad-11d1-80b4-00c04fd430c8',
    '6ba7b812-9dad-11d1-80b4-00c04fd430c8','6ba7b814-9dad-11d1-80b4-00c04fd430c8',
    '11111111-2222-3333-4444-555555555555','deadbeef-dead-beef-dead-beefdeadbeef',
    '01234567-89ab-cdef-abcd-abcdef012345',
  ])('should refuse the pinned probe placeholder class for %s', deployment_id => {
    expect(preparePlan({...target,deployment_id},probe,routine)).toMatchObject({code:'deployment_placeholder_refused'});
  });
  it('should refuse hidden or symbol properties and non-plain request prototypes', () => {
    const hidden={...target};Object.defineProperty(hidden,'extra',{value:'SYNTHETIC'});
    const symbol={...target,[Symbol('SYNTHETIC')]:0};
    const inherited=Object.assign(Object.create({extra:0}) as object,target);
    for(const request of [hidden,symbol,inherited]) expect(checkTarget(request)).toMatchObject({code:'request_shape_refused'});
  });
});

describe('when a synthetic preparation session expires, repeats or is revoked', () => {
  it('should consume exactly one accepted attempt even if output screening refuses it', () => {
    const value=session();
    expect(value.simulate({...failure,stdout:'SYNTHETIC_UNSAFE_OUTPUT'},now)).toMatchObject({status:'output_refused',hold:true});
    expect(value.simulate(failure,now+1)).toMatchObject({code:'synthetic_session_already_consumed'});
  });
  it('should refuse after local revocation without claiming provider access was revoked', () => {
    const value=session();
    expect(value.revoke()).toMatchObject({code:'synthetic_session_revoked'});
    expect(value.simulate(failure,now)).toMatchObject({code:'synthetic_session_revoked'});
    expect(JSON.stringify(value.revoke())).not.toContain('provider');
  });
  it.each([now-1,now+900000,NaN,Infinity])('should refuse invalid or expired request time', time => {
    expect(session().simulate(failure,time)).toMatchObject({code:'synthetic_session_expired',hold:true});
  });
  it('should preserve the fixed refusal and numeric exit while retaining HOLD', () => {
    expect(session().simulate(failure,now)).toMatchObject({status:'screened_failure',exit_code:4,hold:true,mode:'synthetic_only',production_connections:0,remote_cleanup:'not_proven',provider_access_revocation:'not_performed'});
  });
  it('should preserve HOLD even when three synthetic samples report zero observed', () => {
    expect(session().simulate({stdout:syntheticOutput(),stderr:'',exitCode:0,elapsedMs:120000},now)).toMatchObject({status:'screened_report',verdict:'zero_observed_not_proof',mode:'synthetic_only',hold:true,production_connections:0,remote_cleanup:'not_proven'});
  });
  it('should refuse a transcript accessor without reading or echoing it', () => {
    let calls=0;
    const transcript={...failure,get stdout(){calls+=1;return 'SYNTHETIC';}};
    expect(session().simulate(transcript,now)).toMatchObject({code:'transcript_shape_refused'});
    expect(calls).toBe(0);
  });
  it('should label an exceeded synthetic transport budget without claiming application cleanup', () => {
    expect(session().simulate({...failure,elapsedMs:370001},now)).toMatchObject({code:'synthetic_budget_exhausted',hold:true});
  });
  it('should reject unapproved transcript fields and consume the attempt', () => {
    const value=session();
    expect(value.simulate({...failure,command:'SYNTHETIC'},now)).toMatchObject({code:'transcript_shape_refused'});
    expect(value.simulate(failure,now)).toMatchObject({code:'synthetic_session_already_consumed'});
  });
  it.each([NaN,-1,Number.MAX_SAFE_INTEGER])('should reject invalid clock construction', clock => {
    expect(createSyntheticSession(target,probe,routine,clock)).toMatchObject({code:'clock_refused'});
  });
});

describe('when the offline CLI is launched', () => {
  it('should emit only a non-authorised preparation JSON record', () => {
    let output='';
    expect(main(['--prepare',target.deployment_id,target.commit_sha],value=>{output+=value;})).toBe(0);
    expect(JSON.parse(output)).toMatchObject({status:'prepared_not_authorised',hold:true,operator_approval:'not_granted'});
    expect(output.split('\n')).toHaveLength(2);
  });
  it('should refuse unknown arguments without echoing their contents', () => {
    let output='';
    expect(main(['--token','SYNTHETIC_NOT_A_SECRET'],value=>{output+=value;})).toBe(2);
    expect(output).not.toContain('SYNTHETIC_NOT_A_SECRET');
  });
  it.each(['--live','--prepare'])('should make no socket or child-process call from the real CLI entrypoint in %s mode', mode => {
    const folder=mkdtempSync(join(tmpdir(),'controlled-preflight-synthetic-'));
    const guard=join(folder,'guard.cjs');
    try {
      writeFileSync(guard,`const die=()=>{throw new Error('SYNTHETIC_NETWORK_OR_EXEC_FORBIDDEN')};\nrequire('node:net').Socket.prototype.connect=die;require('node:tls').connect=die;\nrequire('node:http').request=die;require('node:https').request=die;\nconst cp=require('node:child_process');for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[k]=die;\n`);
      const args=mode==='--live'?[mode]:[mode,target.deployment_id,target.commit_sha];
      const run=spawnSync(process.execPath,['--require',guard,resolve('scripts/controlled-preflight/prepare.mjs'),...args],{env:{PATH:'/usr/bin:/bin',NODE_ENV:'test'},encoding:'utf8',timeout:5000,maxBuffer:4096});
      expect(run.status).toBe(mode==='--live'?4:0);
      expect(run.stderr).toBe('');
      expect(JSON.parse(run.stdout)).toMatchObject({hold:true,status:mode==='--live'?'refused':'prepared_not_authorised'});
    } finally {rmSync(folder,{recursive:true,force:true});}
  });
});
