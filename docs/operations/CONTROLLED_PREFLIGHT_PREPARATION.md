# Controlled workload preflight — offline preparation only

This increment implements a deterministic preparation and aggregate-result boundary for the immutable Claude workload diagnostic. It is not a private production channel, a new privileged endpoint, a running service, or live-run authorisation. It cannot connect to Railway, a database, or Redis. There is no SSH adapter, credential input, dotenv loading or subprocess execution in the controller/CLI.

The founder authorised preparation and synthetic testing on 6 November 2026. The supplied **Preflight Run Instructions** assigns live Part B to a human terminal. The founder subsequently and explicitly delegated that operator role to Manus: do not hand the eventual technical operation back to the founder. The document remains the specification for pinned code, target checks, load, result handling and HOLD. Preparation approval and operator delegation do not approve new access, credential handling or the exact live run; those gates remain separate.

## Fixed package and interpretation

Source coverage stays pinned to main `4efaac2a1e4d35f9aaa448b2daba4652e7e58dee`. The run-instructions branch head is `b3b323f759dbe205653847af3ad424ce0e93c95f`. A changed target revision refuses preparation until Claude rechecks coverage.

The local `pins/*.source.txt` fixtures are byte-for-byte copies of public code, treated as data and never imported/executed by this package. The probe is pinned to `6c9243f20837ca8ef13c9edacdd39e4234461774`, SHA-256 `9cf0ee931d3643a4b2367e985d2d779d8569a7eea72dffb5c887fb5ee4a31aab`. The routine is pinned to `94d0cd1b2a92d76fe16f7592c664e0c4319ac19f`, SHA-256 `a01f2938dceb5016f638fb5855445996cf89ab72c4e65d47392399fff58cdb00`.

The prepared input can contain only the verified unchanged routine followed by its fixed invocation using one lowercase full deployment UUID and the checked full source SHA. No custom command, path, timeout, credential or target override is accepted. The `/app` default is retained. Building those input bytes never executes them.

The actual diagnostic reads workload counts, bounded ages, named queue counts and named application signal settings. TiDB write protection is `statement_guard_only`, not database-enforced read-only privileges. It also uses approved session UTC and snapshot/rollback control statements. The fixed plan is three samples, 60-second waits, a 300-second probe budget, a 360-second wrapper timeout and a further ten-second termination margin for the probe. Download/setup happen before that probe timeout. These values do not authorise killing or draining the application.

The result boundary parses the documented v2 shape, whitelists field names/types/string values, rejects unexpected or inconsistent data, limits both output sizes, and reconstructs fixed safe results. It does not treat a general identifier regex as permission to carry arbitrary labels. A shape-valid report is still a statement from its source, not proof of server authenticity, writer quiescence, customer usage or recovery readiness.

All results retain `hold: true`. In particular, `zero_observed_not_proof` is not deployment permission. Incomplete evidence is never converted to zero. Local request expiry/one-use/revocation are tested only as a synthetic model; they are not provider-enforced access expiry or proof of remote cleanup.

## Offline use

The only CLI mode is preparation. Run `node scripts/controlled-preflight/prepare.mjs --prepare <full-deployment-uuid> <checked-full-commit-sha>` in a reviewed local checkout. It reads only the two fixed public source fixtures and emits one JSON preparation record with `operator_approval: not_granted` and `live_adapter: absent`. Placeholder, shortened or changed identities refuse. `--live` always refuses, even if approval-like fields are supplied. No successful local command is a production action.

Tests construct clearly synthetic transcripts in memory. A real CLI subprocess test forbids network and child-process methods before loading the CLI. The fixture sources are unchanged and the output validator is tested independently. No production values, processes, queues or records are inspected.

## Future transport: not built or approved here

A future controller would sit on the private side of a trusted transport and keep the existing database and Redis credentials inside the application runtime. The model should return only bounded aggregate JSON and fixed errors; arbitrary stdout/stderr, transcripts, job IDs, rows and environment contents must never cross into the agent-visible result.

The founder has selected Manus as the eventual operator. Before adding live capability, explain and obtain approval for the authentication/access method, its exact scope and lifetime. Independently authenticated server trust is required. The currently documented Railway SSH model has broader potential access than this one diagnostic; a local command restriction cannot be described as a provider-enforced permission. Gateway host-key trust is unresolved. Unknown or changed keys must refuse. Existing agent-socket signing, if later chosen and separately approved, is authentication capability, not a secret enclave; the socket is not automatically available to Manus. No key, agent socket or token is inspected in this increment.

A future adapter needs tests for independently trusted host-key verification/refusal, actual authenticated transport binding to the exact deployment, fixed stdin delivery, safe handling of raw transport failures, hard local and remote limits, interrupted/disconnected remote lifecycle, cleanup acknowledgement and provider-access revocation. The current synthetic result tests do **not** establish those properties. Killing a local SSH client does not prove the remote probe stopped.

Fresh Railway ACTIVE metadata and a separate exact one-run approval are required even after a transport is ready. Every retry requires an explicit decision; the controller never retries silently. No merge, deploy, restart, producer pause, data cleanup, backup, restore, paid resource, credential rotation or history rewrite is authorised here. Keep the preparation PR in draft/HOLD: main auto-deploys, and publishing these files is not needed to run the immutable original package.

## Public references

- [Pinned runbook](https://github.com/Infinity-AI-Africa-Limited/reconcileai/blob/b3b323f759dbe205653847af3ad424ce0e93c95f/docs/operations/PRODUCTION_WORKLOAD_PREFLIGHT.md).
- [Railway SSH](https://docs.railway.com/cli/ssh).
- [OpenSSH configuration](https://man.openbsd.org/ssh_config).
- [OpenSSH agent](https://man.openbsd.org/ssh-agent).

Do not add private Claude session links, the supplied PDF, live configuration, credentials or raw production evidence to this public repository.
