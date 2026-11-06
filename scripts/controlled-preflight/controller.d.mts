import type { Buffer } from 'node:buffer';
import type { ScreenedOutput } from './report.mjs';
export type Refusal = Readonly<{schema:string; status:'refused'; code:string; hold:true}>;
export type Target = Readonly<{status:'validated';deployment_id:string;commit_sha:string}>;
export type PreparationPlan = Readonly<{
  schema:string;status:'prepared_not_authorised';hold:true;deployment_id:string;commit_sha:string;
  probe_commit:string;probe_sha256:string;routine_commit:string;routine_sha256:string;
  operation:'single_pinned_workload_diagnostic';samples:3;interval_seconds:60;probe_budget_seconds:300;
  wrapper_timeout_seconds:360;wrapper_kill_after_seconds:10;live_adapter:'absent';authentication:'not_configured';
  operator_approval:'not_granted';database_write_protection:'statement_guard_only';production_cleanup:'not_performed';
}>;
export const SPEC: Readonly<{
  schema:string;checkedMain:string;branchHead:string;probeCommit:string;probeSha256:string;
  routineCommit:string;routineSha256:string;samples:3;intervalSeconds:60;probeBudgetSeconds:300;
  wrapperLimitSeconds:360;wrapperKillAfterSeconds:10;appDirectory:'/app';
}>;
export function checkTarget(request:unknown):Target|Refusal;
export function verifyArtifacts(probeBytes:unknown,routineBytes:unknown):Refusal|Readonly<{status:'validated';code:'pinned_artifacts_verified'}>;
export function preparePlan(request:unknown,probeBytes:Buffer,routineBytes:Buffer):PreparationPlan|Refusal;
export function buildRemoteInput(request:unknown,probeBytes:Buffer,routineBytes:Buffer):Refusal|Readonly<{status:'prepared_not_authorised';hold:true;remote_command:'/bin/sh -s';stdin:string}>;
export function requestLiveRun(..._ignored:unknown[]):Refusal;
export type SyntheticSession = Readonly<{
  status:'synthetic_session';plan:PreparationPlan;revoke():Refusal;
  simulate(transcript:unknown,nowMs:number):Refusal|(ScreenedOutput & {
    mode:'synthetic_only';hold:true;production_connections:0;remote_cleanup:'not_proven';provider_access_revocation:'not_performed';
  });
}>;
export function createSyntheticSession(request:unknown,probeBytes:Buffer,routineBytes:Buffer,createdAtMs:number):SyntheticSession|Refusal;
