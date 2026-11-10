# Maintenance single-promotion candidate

**DRAFT / HOLD — preparation only. No merge to main, deployment, provider action or live reading is authorized.**

This candidate assembles the already reviewed diagnostic and shutdown-grace changes into one source tree. It does not certify the current deployment, database or recoverability. It must return to Claude for integration review and later receive a separate exact owner release approval.

## Reviewed inputs and integration

The authoritative starting main is `4efaac2a1e4d35f9aaa448b2daba4652e7e58dee`. The diagnostic page candidate is `04efefef7366a29ec320669ddf728ac3073ceba7` from #231, containing backend `8549af0`, Manus hardening `cfd1ef0` and Claude's clock-skew correction. The held grace candidate is `29ca17f313533a7e07196e10400eb6118cca21d4` from #218.

The feature worktree started from fresh authoritative main, fast-forwarded to the reviewed page, and integrated the grace commits with a normal merge. The sole conflict was the test-typing list: both sets of additions and all newer-main entries were retained. No diagnostic logic, query catalogue, dependency, schema, migration, credential or role change is introduced by this integration. The only deployment recipe changes remain the reviewed direct Node launcher, 120-second draining allowance and zero intentional overlap delay. Build, health and restart settings and the existing `pnpm db:migrate` pre-deploy hook remain unchanged.

The final commit and tree are recorded outside this file after the integration commit is created, then validated on that exact head. This avoids a self-referential commit claim. Any later main/source/configuration change invalidates the release pin and requires fresh review and validation.

## One eventual promotion, not three intermediate deployments

The recommended mechanism is **one combined authoritative PR to main**. If every remaining gate is satisfied and the owner approves the exact release, Claude merges that candidate to main in one coordinated action, with no unrelated merge racing the promotion. The existing #218/#230/#231 must not be merged separately first. The draft follow-up #232 was integrated into the page branch, not main.

This mechanism is source-prepared only. Main auto-deploy behavior, connected branch, staged-change provenance and provider build eligibility still need current non-secret native evidence. No Railway auto-deploy pause/toggle is changed. If one coordinated push cannot be evidenced, retain HOLD rather than improvising intermediate promotions. No merge command or live instruction is supplied by this document.

## Approved access policy, not execution approval

Richard selected policy A on 10 November 2026: existing super admins may access the page, and **only Richard operates the first controlled rehearsal**. The server-side super-admin/reviewer gates remain unchanged. This does not grant a role, create an account, audit existing super-admin assignments or approve the first live button press. That later operator action must have its own bounded approval and must not be performed by Manus or another operator on Richard's behalf.

Normal authentication may update `lastSignedIn`; the diagnostic itself does not write business/workload records. Statement allow-list protection on TiDB is not database-enforced read-only access. A configured timeout hint and a retired client socket do not prove server-side cancellation. Reports always retain HOLD; a quiet reading is not maintenance or deployment permission.

## Gates before a release decision

- **Exact candidate and review:** Claude's integration review, tests on the final pinned tree, and a single coordinated promotion mechanism. Mounted DOM and a running authenticated rehearsal have not yet been completed; their approved synthetic/live scopes must be distinguished.
- **Current runtime and migration evidence:** Verify active deployment/configuration and compare the live migration state with this candidate's journal through a separately approved restricted path. No new migration in the diff does not prove the pre-deploy hook will do nothing. No production variable value, connection string, customer payload or raw log may enter task output.
- **First replacement and writer safety:** The running process's effective shutdown snapshot and workload/intake safety must be evidenced. The new 120-second setting is an allowance for deployments carrying it, not proof of protection for the first replacement of the old process. The check is not a writer fence and cannot vouch for its own first deployment.
- **Recovery and fallback:** Protected portable export, isolated-restore and deployment-validation gates remain unwaived. A retained rollback target must be compatible with the reviewed image, post-promotion schema/migration state, effective configuration and current runtime credential references. A forward revert needs the same compatibility evidence. Neither fallback reverses database writes. Missing evidence means HOLD.
- **Provider compatibility and deadline:** The legacy configuration and builder must be confirmed supported/effective for this existing service before promotion. The current reference does not list the retained `NIXPACKS` builder, so local launcher/JSON tests are not provider parsing proof. Railway states a hard legacy Config as Code cutoff of **1 December 2026**. Do not approve execution on or after that date under an assumption `railway.json` still applies. A separately reviewed and owner-approved infrastructure migration is required; do not silently add it here.[1] [2]
- **Owner approval:** The exact promotion, operational window, risk/evidence, fallback and first owner-operated live reading need explicit separate approval. Access-policy approval is not any of those approvals.

## What remains out of scope

No Railway service/project/database/Redis creation, real management key, connector change, provider variable render, IaC pull/plan/apply/migrate, billing action, restart, writer stop, unpublish, production query, export/restore, credential rotation, stuck-work cleanup, funds movement or App Store submission. The retired Custom API credential route must not be reused. No scheduled check or unattended first rehearsal is introduced.

## References

[1]: https://docs.railway.com/config-as-code/reference "Railway legacy configuration precedence, timing fields and deprecation cutoff"
[2]: https://docs.railway.com/infrastructure-as-code "Railway IaC replacement, hard cutoff and migration ownership boundary"
