# Maintenance single-promotion candidate

**DRAFT / HOLD — preparation only. No merge to main, deployment, provider action or live reading is authorized.**

Claude cleared the integration at `f07e53a7c45e98af7e1418b01ef05583e57d4343` in the #233 comment linked below. That is not release approval or proof of the current deployment, database or recoverability. This documentation-only follow-up preserves that cleared runtime code, revises the deadline plan and returns the amendment for review. Exact owner release approval remains separate.[9]

## Reviewed inputs and integration

The authoritative starting main is `4efaac2a1e4d35f9aaa448b2daba4652e7e58dee`. The diagnostic page candidate is `04efefef7366a29ec320669ddf728ac3073ceba7` from #231, containing backend `8549af0`, Manus hardening `cfd1ef0` and Claude's clock-skew correction. The held grace candidate is `29ca17f313533a7e07196e10400eb6118cca21d4` from #218.

The integration worktree started from fresh authoritative main, fast-forwarded to the reviewed page, and merged the grace commits normally. The sole conflict was the test-typing list: both sets of additions and all newer-main entries were retained. No diagnostic logic, query catalogue, dependency, schema, migration, credential or role change was introduced by that integration. The only deployment recipe changes remain the reviewed direct Node launcher, 120-second draining allowance and zero intentional overlap delay. Build, health and restart settings and the existing `pnpm db:migrate` pre-deploy hook remain unchanged.

The cleared runtime head and tree are `f07e53a7c45e98af7e1418b01ef05583e57d4343` and `c9c2332ffe33a917c429e453cf00014c0e9686d4`. This follow-up starts in another fresh-main feature worktree, fast-forwarded to that pin, and changes this document only. Its new documentation head is recorded in its PR/evidence after commit. Any later main/source/configuration change invalidates a release pin and requires fresh review and validation.

## One eventual promotion, not three intermediate deployments

The recommended mechanism is **one combined authoritative PR to main**. If every remaining gate is satisfied and the owner approves the exact release, Claude merges the final reviewed candidate in one coordinated action, with no unrelated merge racing the promotion. The existing #218/#230/#231 must not be merged separately first. #232 was integrated into the page branch, not main.

This mechanism is source-prepared only. Main auto-deploy behavior, connected branch, staged-change provenance and provider build eligibility still need current non-secret native evidence. No Railway auto-deploy pause/toggle is changed. If one coordinated push cannot be evidenced, retain HOLD rather than improvise intermediate promotions. No merge command or live instruction is supplied by this document.

## Approved access policy, not execution approval

Richard selected policy A on 10 November 2026: existing super admins may access the page, and **only Richard operates the first controlled rehearsal**. Server-side super-admin/reviewer gates remain unchanged. This does not grant a role, create an account, audit existing assignments or approve the first live button press. That later operator action needs its own bounded approval and must not be performed by Manus or another operator on Richard's behalf.

Normal authentication may update `lastSignedIn`; the diagnostic itself does not write business/workload records. TiDB statement allow-list protection is not database-enforced read-only access. A configured timeout hint and retired client socket do not prove server-side cancellation. Reports retain HOLD; a quiet reading is not maintenance or deployment permission.

## Gates before a release decision

- **Exact candidate and review:** Claude's integration clearance is evidenced at the old exact pin. The documentation amendment and final source/configuration combination still require review. Tests and a coordinated promotion mechanism must be bound to the final pin. Mounted DOM and a running authenticated rehearsal are not completed; synthetic/live approvals remain distinct.
- **Current runtime and migration evidence:** Source parity is confirmed: no `drizzle/`, package or lockfile change versus main; both committed journals have 120 entries ending at `0119`. If the active deployment is proven to use that same source and to have successfully run its migration step, repeating an already successful journal is a useful inference, not a current live migration read or proof against out-of-band changes. No new migration in a diff does not prove the hook will do nothing. Verify active deployment/configuration and live migration state through a separately approved restricted path. Keep existing migration/recovery gates unwaived unless the owner explicitly resolves the governance decision. No raw logs, production variable values, connection strings or customer payloads may enter task output.[9]
- **First replacement and writer safety:** Evidence the running process's effective shutdown snapshot and workload/intake safety. The new 120-second setting is an allowance for deployments carrying it, not protection for the old process's first replacement. The diagnostic is not a writer fence and cannot vouch for its own first deployment.
- **Recovery and fallback:** Protected portable export, isolated restore and deployment validation remain unwaived. A retained rollback target and a forward revert both need image, post-promotion schema/migration, effective configuration and current credential-reference compatibility. Neither reverses database writes. Missing evidence means HOLD.
- **Provider compatibility and deadline:** Railway stops reading legacy Config as Code on **1 December 2026**. The deadline path is evidence-led, separately owner-approved preservation of supported settings in the service dashboard, committed without redeploy only if the actual UI and whole staged batch are verified. IaC is optional later, not a mandatory prerequisite for the cutoff. The retained `NIXPACKS` builder is not listed in current documented values; verify continuity rather than switch or claim provider parsing from local tests. After the cutoff, approve no deployment until its exact effective dashboard-based recipe and builder are evidenced. Verified parity can remove dependence on the legacy file, but no parity or no-op outcome is claimed today.[1] [2] [3]
- **Owner approval:** The exact settings-preservation batch, later promotion, window, risk/evidence, fallback and first owner-operated live reading need explicit separate approval. Access-policy approval is not any of those approvals.

## Deadline path: evidence first, preservation before promotion

First collect non-secret evidence for the application service in the exact production environment: Settings fields and editability, staged-change count, active deployment success/source and stored configuration, and plan tier only. Do not capture the whole billing page, Variables, raw logs, credentials or customer data. Cropped screenshots or explicit non-secret field values suffice. Missing fields are recorded as not shown, never guessed. Preserve existing staged work; unrelated or variable-containing batches block a combined commit until provenance and safe isolation are resolved. Read-only collection does not approve mutation.[9]

The conservative first batch, if later specifically approved, is **like-for-like preservation of the current effective recipe**, not blind installation of every held candidate delta. The inspected main file specifies `pnpm build`, `pnpm db:migrate`, `pnpm start`, `/api/healthz` with 120-second health timeout, ON_FAILURE with 10 retries and the existing NIXPACKS builder. These source values are a comparison baseline, not instructions to replace unknown dashboard values. If active settings differ, stop for provenance review. If the builder cannot be preserved in a supported way, stop for separately reviewed build engineering. No paid test service or builder change is authorized here.

Treat the candidate's changed direct start command and newly added draining/overlap as a **second, separately approved batch coordinated with final promotion**. Current main omits draining and overlap. Precedence is per key: environment-specific code, base code, then service settings. An omitted field can apply in a future deployment before the cutoff. 'The file exists, so every dashboard change is suppressed' is false. Any proposal to prepare candidate deltas earlier must disclose mixed-configuration/early-deployment effects and receive exact owner approval. No such preparation is performed here.[1]

Railway documents holding Alt while clicking Deploy to commit staged changes without triggering a redeploy. This is a documented capability, not a blindly authorized keyboard action. Before mutation, verify the target, field-level old/new diff, entire staged batch and actual no-redeploy UI mode. The batch must contain only the exact approved app-setting changes, not networking/resource/variable/billing actions. Ordinary Deploy can apply all staged work and redeploy affected services; networking changes can apply immediately. Obtain exact owner approval before changing or committing fields. Afterwards require supported non-secret commit receipts, no new deployment at the operation checkpoint and field parity. An ambiguous or missing control means stop, not ordinary Deploy or variable-based settings. Do not open Variables or set `RAILWAY_DEPLOYMENT_*` variables under this plan.[3]

A no-redeploy commit does not modify the running process's original snapshot or protect its first replacement. Draining uses the outgoing deployment's snapshot; overlap is read from the incoming deployment. Railway-initiated maintenance deployments are mandatory and cannot be opted out of. HOLD is not risk-free, and preservation should be prioritized this week, but that risk does not authorize a rushed release or waive recovery. The checked sources do not resolve field-by-field which settings are used by every provider-initiated redeployment; do not invent that assurance.[4] [5] [6]

Record the actual plan tier and retained rollback target, not assumed Hobby/Pro or availability. Published image retention starts at removal: Free/Trial 24 hours, Hobby 72, Pro 120, Enterprise 360. Retained-image rollback restores image, settings and variables and involves a service transition; it does not reverse database writes. Current credential-reference, post-promotion schema/configuration and recoverability compatibility still need evidence. A restored older snapshot can restore older grace settings. No rollback or rebuild is authorized here.[7] [8]

## What remains out of scope

No Railway service/project/database/Redis creation, real management key, connector change, provider variable render, IaC pull/plan/apply/migrate, billing action, settings mutation/commit, restart/redeploy, writer stop, unpublish, production query, export/restore, credential rotation, stuck-work cleanup, funds movement or App Store submission is performed or approved by this document. Later dashboard preservation needs its own exact owner authorization. The retired Custom API credential route must not be reused. No scheduled check or unattended first rehearsal is introduced.

## References

[1]: https://docs.railway.com/config-as-code/reference "Railway per-setting precedence, fields and legacy cutoff"
[2]: https://docs.railway.com/infrastructure-as-code "Railway hard legacy cutoff and infrastructure management boundary"
[3]: https://docs.railway.com/deployments/staged-changes "Railway whole-batch staged changes and commit without redeploy"
[4]: https://station.railway.com/questions/which-draining-configuration-applies-to-4b18d1d8 "Railway staff clarification of outgoing and incoming deployment snapshots"
[5]: https://docs.railway.com/deployments/deployment-teardown "Railway signal and overlap teardown intervals"
[6]: https://docs.railway.com/deployments/reference#railway-initiated-deployments "Railway mandatory provider-initiated redeployments"
[7]: https://docs.railway.com/pricing/plans#image-retention-policy "Railway retained-image windows and restoration scope"
[8]: https://docs.railway.com/deployments/deployment-actions#rollback "Railway rollback and redeploy behavior"
[9]: https://github.com/Infinity-AI-Africa-Limited/reconcileai/pull/233#issuecomment-6785737650 "Claude integration clearance and deadline-plan recommendation"
