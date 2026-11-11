# Maintenance single-promotion candidate

**DRAFT / HOLD — preparation only. No merge to main, deployment, provider action or live reading is authorized.**

Claude cleared integration `f07e53a7c45e98af7e1418b01ef05583e57d4343` and the one-document amendment `beb8f7a635361e41ce73653e87c800e6ef1b017e` as a plan, not a release. This further documentation-only follow-up adds the requested cutoff fallbacks and corrects source attribution. Runtime code and configuration stay identical to the cleared integration. This new document requires review; exact owner release approval remains separate.[9] [10]

## Reviewed inputs and integration

The authoritative starting main is `4efaac2a1e4d35f9aaa448b2daba4652e7e58dee`. The diagnostic page candidate is `04efefef7366a29ec320669ddf728ac3073ceba7` from #231, containing backend `8549af0`, Manus hardening `cfd1ef0` and Claude's clock-skew correction. The held grace candidate is `29ca17f313533a7e07196e10400eb6118cca21d4` from #218.

The original integration started from fresh authoritative main, fast-forwarded to the reviewed page and merged the grace commits normally. Its sole conflict was the test-typing list; both sets of additions and newer-main entries were retained. No diagnostic logic, query catalogue, dependency, schema, migration, credential or role change was introduced. Its only deployment-recipe changes are the reviewed direct Node launcher, 120-second draining allowance and zero intentional overlap delay. Build, health, restart and the existing `pnpm db:migrate` pre-deploy hook remain unchanged.

The cleared runtime head and tree are `f07e53a7c45e98af7e1418b01ef05583e57d4343` and `c9c2332ffe33a917c429e453cf00014c0e9686d4`. This follow-up starts in another fresh-main feature worktree, fast-forwarded to the cleared amendment, and changes this document only. Its head is recorded in the PR/evidence after commit. Later main/source/configuration changes require a fresh release pin, review and validation.

A narrow Git-history audit corrects the reported chronology: tracked root `railway.json` was added on 3 June 2026 at `27d435b1b6c642f65f65c4edd1452f36f261ff16`; `0bf8a277ccaf547bba00a580d8edc5e9aee08929` added the pre-deploy migration command on 18 June. Current main has that June-18 content. The later grace edits are on the held candidate, not main. `4cb731e186492b516f643cea875c8da27e2e0088` deletes a migration file; it is not the config-file addition. History cannot prove independently stored dashboard fields are empty. Treat them as **unverified and unavailable for safety reliance until read**, not observed empty values.

## One eventual promotion, not intermediate deployments

The recommended mechanism is **one combined authoritative PR to main**. Only after all gates and exact owner release approval may Claude merge the final reviewed candidate in one coordinated action, with no unrelated merge racing it. #218/#230/#231 must not be merged separately first. #232 was integrated into the page branch, not main.

Connected branch, auto-deploy, staged-change provenance and build eligibility need current native evidence. The 11 November browser read showed main connected and the Disable auto-deploy action, indicating auto-deploy enabled then. No toggle was changed. **A no-deployment freeze includes no merge or push to main**, no manual deployment/rebuild and no deployment-affecting settings commit. It requires a separately approved operating plan and does not prevent mandatory Railway-initiated deployments.[6]

## Approved access policy, not execution approval

Richard selected policy A on 10 November 2026: existing super admins may access the page, and **only Richard operates the first controlled rehearsal**. Server-side super-admin/reviewer gates stay unchanged. This grants no role, account or first live button press. The later operator action needs bounded approval and must not be performed by Manus or another operator on Richard's behalf.

Normal authentication may update `lastSignedIn`; the diagnostic does not write business/workload records. TiDB statement allow-list protection is not database-enforced read-only access. A timeout hint and retired client socket do not prove server-side cancellation. Reports retain HOLD; a quiet reading is not maintenance or deployment permission.

## Source authority and unresolved behavior

Official documentation establishes the cutoff, per-key precedence, general teardown timing, mandatory provider redeployments and image retention. Central Station answers previously called staff replies are identified in Claude's correction as **Railway BOT**, not a named engineer. The extraction tool can render the author simply as Railway; that does not establish human-engineer attribution.[1] [2] [5] [6] [7] [10] [11]

Three bot-only assertions are **likely, not confirmed**: outgoing-snapshot draining versus incoming-snapshot overlap; silent service-settings takeover/error behavior after the cutoff; and rollback restoring old service variables while shared/Railway-provided variables use current values. These support conservative HOLD, not transition approval. Keep schema/current-credential-reference checks regardless of variable model. Obtain official documentation or named-engineer confirmation and service-specific evidence before relying on these details.[4] [10] [11] [12]

## Gates before a release decision

- **Exact candidate and review:** Integration and the earlier plan amendment are cleared at their exact pins. This amendment and final source/configuration combination require review. Tests and promotion must bind to the final pin. Mounted DOM and authenticated running rehearsal remain incomplete; local synthetic and live approvals are distinct.
- **Current runtime and migrations:** No `drizzle/`, package or lockfile change versus main; both journals have 120 entries ending at `0119`. Matching active source and a successful migration step would support an inference about repeating the journal, not prove live state or absence of out-of-band changes. No new migration in a diff does not prove the hook does nothing. Existing migration/recovery gates remain unwaived. No raw logs, variable values, connection strings or customer payloads may enter task output.[9]
- **First replacement and writer safety:** Evidence effective shutdown behavior and workload/intake safety. The new allowance is not proven protection for the current process's first replacement. Plan conservatively for an abrupt first replacement unless stronger evidence proves otherwise; do not represent the bot-only snapshot rule as confirmed. The diagnostic is not a writer fence and cannot vouch for its own first deployment.
- **Recovery and fallback:** Protected portable export, isolated restore and deployment validation remain unwaived. Retained rollback and forward revert need image, post-promotion schema/migration, effective configuration and current credential-reference compatibility. Neither reverses database writes. Missing evidence means HOLD.
- **Builder and deadline:** Legacy Config as Code stops being read on **1 December 2026**. Preserve supported dashboard settings only through an evidenced, separately owner-approved path. Docs list RAILPACK and DOCKERFILE, not NIXPACKS. Prepare for likely Railpack; do not claim existing-service selection, a successful build or hosted parity without evidence. IaC is optional later.[1] [2] [10]
- **Owner approval:** Exact preservation, builder change, promotion, window/fallback and first owner-operated live reading need separate approval. Access-policy approval and plan clearance are none of those.

## Deadline path: two batches with no unsafe resting state

First collect non-secret app-service/environment evidence: effective Settings and independently stored values/editability, full staged batch, active source/stored configuration, retained-image eligibility and builder support. Richard confirmed **Hobby** on 11 November; do not ask again or open billing. Missing fields are not shown, never guessed. Do not capture Variables, raw logs, credentials, customer data or whole billing pages. Unrelated or variable-containing staged changes block a combined commit until provenance and safe isolation are resolved.

**Batch 1 preserves today's supported recipe**, subject to exact approval and effective parity: `pnpm build`, `pnpm db:migrate`, `pnpm start`, `/api/healthz`, 120-second health timeout and ON_FAILURE with 10 retries. These are comparison values, not instructions to overwrite unknown dashboard values. Current Settings show Nixpacks Deprecated with file-source labels. The bot reports Nixpacks no longer selectable and official docs omit it; like-for-like builder preservation cannot be promised. A builder choice needs separate reviewed evidence and approval. Partial command preservation is not complete cutoff readiness.[1] [10]

**Batch 2 carries the candidate's direct start and teardown settings**, separately approved and coordinated with promotion: `NODE_ENV=production exec node dist/index.js`, 120-second draining and zero overlap. Precedence is per key. Current main omits draining/overlap, so saving candidate deltas may affect future deployments before the cutoff. File existence does not suppress every dashboard key; disclose early/mixed effects and obtain exact approval.[1]

**Batch 1 alone is not a safe resting state after candidate promotion.** If promotion precedes the cutoff, batch 2 must also be independently persisted and verified before the first deployment after it. Otherwise old `pnpm start` and absent draining can return if service settings take over. Silent takeover is bot-only, but the possible regression blocks that transition until resolved. Dashboard settings must match the release actually live, not historical main. No deployment or merge while that mismatch is unresolved.[10] [11]

Railway documents Alt+Deploy to commit without redeploy. This is a capability, not an authorized keyboard action. Verify target, field-level old/new diff, entire batch and actual no-redeploy mode; obtain exact approval. Exclude networking/resource/variable/billing changes. Ordinary Deploy redeploys affected services and networking may apply immediately. Afterwards require non-secret receipts, no new deployment at the checkpoint and independently persisted parity. An unclear control means stop. No Variables or `RAILWAY_DEPLOYMENT_*` fallback; Claude withdrew it.[3] [10]

## If fields are locked or stored values cannot be read

Stop rather than toggle config ownership, remove the file or use a management-key API. First ask Railway **three narrow non-secret questions**, with owner-approved posting: dashboard editability/stored-value verification while overridden by the file; the builder after cutoff; and current-setting versus image/snapshot resolution for Railway-initiated operations. Seek official documentation or named-engineer confirmation, not a bot guarantee. A question draft or reply does not authorize operations.

Without a confirmed pre-cutoff path, the contingency is a **separately approved no-deployment/no-main-merge freeze starting before the cutoff and continuing until parity is evidenced**. In the first hours after cutoff, attempt the exact separately approved dashboard-only batch **before any deployment**, only if fields are actually editable and the no-redeploy control/entire batch are verified. Unlocking after cutoff is an assumption, not a scheduled certainty. If locked, ambiguous, mismatched or unsupported, retain HOLD and escalate; no ordinary Deploy, IaC migration, real key or variable fallback.

This does not mean waiting until December is safe. Mandatory Railway migrations may interrupt that owner-controlled freeze. Obtain the provider-resolution answer promptly. If no safe path is established, bring Richard a fresh residual-risk/alternative decision; do not waive recovery or improvise a migration.[6]

## Separate Railpack rehearsal proposal — not approved here

Claude read Railpack at `f268ae8` against this repository: Node 22 from `.nvmrc`, pnpm 10.4.1 from `packageManager`, staged patches, no Nixpacks-only config and migration tooling in the runtime. He found no obvious blocker. This is source review, **not a build**; compatibility is not proven.[10]

On Richard's separate go-ahead, Claude may prepare a draft PR for pinned Railpack on existing GitHub-hosted test machines, committed migrations against disposable CI MySQL, image startup and `/api/healthz` with synthetic runtime fixtures only. No Railway access/key, production secrets/data, paid runner/resource, billing change or deployment. This would prove public-tool compatibility, not Railway-hosted build/deployment parity. Manus may review and mirror it normally. This amendment neither implements nor runs it.

If it fails, a reviewed Dockerfile is a possible fallback, not an automatic change. Do not casually add a root Dockerfile: Railway's auto-detection means merging it can change production's builder. The nested on-prem Dockerfile is not proof of an approved or built SaaS fallback.[1] [13]

## Hobby retained-image limits

Owner-confirmed Hobby retains images for **72 hours after removal**, not from build age. The ACTIVE legacy Nixpacks-associated deployment is the preservation/rollback baseline; an exact live image/source pin is still needed. Its age alone does not exhaust that window. Verify each REMOVED target's eligibility and removal time where available; do not assume old rows recoverable.[7]

Once a removed legacy image expires, Redeploy cannot be assumed to recreate it: rebuilding uses original source/variables and the then-applicable builder, not necessarily Nixpacks. Restoring a retained image creates a transition and does not restore the database. Official docs describe settings/variables restoration broadly; the precise old-service/current-shared split is bot-only. Compatibility remains mandatory. No rollback or rebuild is authorized.[7] [8] [12]

## What remains out of scope

No Railway service/project/database/Redis creation, real management key, connector change, variable render, IaC pull/plan/apply/migrate, billing action, settings mutation/commit, restart/redeploy, writer stop, unpublish, production query, export/restore, credential rotation, stuck-work cleanup, funds movement or App Store submission is performed or approved. Later preservation needs exact owner approval. The retired Custom API route must not be reused. No scheduled check, unattended freeze or first rehearsal is introduced.

## References

[1]: https://docs.railway.com/config-as-code/reference "Official per-setting precedence, current builder values and legacy cutoff"
[2]: https://docs.railway.com/infrastructure-as-code "Official hard legacy cutoff and management boundary"
[3]: https://docs.railway.com/deployments/staged-changes "Official commit without redeploy"
[4]: https://station.railway.com/questions/which-draining-configuration-applies-to-4b18d1d8 "Railway support bot snapshot answer, not named-engineer confirmation"
[5]: https://docs.railway.com/deployments/deployment-teardown "Official signal and overlap timing"
[6]: https://docs.railway.com/deployments/reference#railway-initiated-deployments "Official mandatory provider deployments"
[7]: https://docs.railway.com/pricing/plans#image-retention-policy "Official retained-image windows and broad restoration scope"
[8]: https://docs.railway.com/deployments/deployment-actions#rollback "Official rollback and redeploy behavior"
[9]: https://github.com/Infinity-AI-Africa-Limited/reconcileai/pull/233#issuecomment-6785737650 "Claude's earlier integration clearance"
[10]: https://github.com/Infinity-AI-Africa-Limited/reconcileai/pull/234#issuecomment-6797458308 "Claude's plan clearance and requested additions"
[11]: https://github.com/Infinity-AI-Africa-Limited/reconcileai/pull/233#issuecomment-6797458733 "Claude's explicit correction and withdrawn fallback"
[12]: https://station.railway.com/questions/deployment-image-retention-reuse-and-r-a816ebd1 "Railway support bot precise rollback-variable assertion"
[13]: https://docs.railway.com/builds/dockerfiles "Official Dockerfile auto-detection"
