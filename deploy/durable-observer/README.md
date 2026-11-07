# Separate observer artifact — not a live deployment recipe

This preparation directory is **not referenced by the existing Railway app config**. Do not change the app's root directory or point it at these files.

After review, `node scripts/durable-observer/build.mjs` builds only the synthetic observer into `dist/durable-observer`. It does not build the application, run migrations, load configuration or install packages. The artifact has no network/database driver imports, source maps, runtime packages or credential reader. `manifest.json` records byte hashes of its three files; these are reproducibility evidence, not a signed trust root or provider deployment attestation.

`node dist/durable-observer/launch.mjs --synthetic=zero` runs a fixed simulation. Supported scenarios are `zero`, `unfinished`, `read_failure`, and `malformed`. With no argument or any live/unknown argument it refuses before importing the child. All outcomes retain HOLD. The launcher strips inherited environment from its child, suppresses child stderr, caps buffered output and time, and validates a closed aggregate report before release. A malformed child report never gets printed. Infrastructure/runtime instrumentation can execute before the launcher; this artifact does not attest provider-wide log safety.

The Dockerfile is a **nondeployable-by-default preparation template**: it requires a separately verified digest-pinned Node base image and an artifact-only build context. No image was built or pushed during this task. Do not pass secrets as build arguments. Do not use a mutable image tag or copy the repository root. A later review must inspect the actual image digest, software bill of materials and runtime environment before granting any reference access.

The executable artifact deliberately has no production adapter. MySQL/Redis adapters in `*.testkit.ts` accept only the dedicated loopback fixtures and are not included in this image. They are synthetic protocol/SQL tests, not TiDB, TLS, credential-scope or live-writer proof.

## Future separately reviewed implementation and approvals

A production runtime needs verified TLS identities, provider-only approved DB/Redis references, independent fresh application/artifact/service mapping, source/schema coverage revalidation and output screening on every startup/error/interruption path. Do not substitute observer identity/environment for the target app. A process flag cannot prevent a dashboard operator from redeploying; a failed launch consumes owner approval.

Before resource creation, supply an account-specific cost cap, one-replica/manual/no-cron/no-autodeploy/no-domain/Never-restart settings, independent termination/lifetime limits and owner-approved stop/removal authority. No shared `.env`, wholesale variable copy, local `railway run`, SSH trust bypass, package install hook or application migration is authorised.

No resource, network, credential grant, live run, paid image registry or service deletion is performed by these files. Existing production and Shopify recovery holds remain.

Static review found and corrected partial-constructor cleanup in the loopback testkit; a failed second allocation now disposes the first and emits a fixed error. Synthetic tests include constructor and disposal diagnostic sentinels. The ioredis SCAN checks are explicitly post-decode acceptance bounds, not proof of a wire/parser allocation limit. Do not reuse this testkit as a live runtime adapter.
