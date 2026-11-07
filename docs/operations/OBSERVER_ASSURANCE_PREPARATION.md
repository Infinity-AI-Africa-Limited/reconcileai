# Observer assurance reducers — preparation only

This increment follows Claude's reviewed runtime adapter head `09f156a`. It does not change the application, the deployment recipe, the observer's default live refusal, or the platform identity observer's unresolved blockers. No authenticated transport is wired into this code. No live observation, credentials, service creation or paid resource is authorised by its tests or outputs.

## Corrected fixture ownership

Claude moved the reused-driver integration into the first case in the shared loopback fixture block. The separate test file and its compiler-list entry were removed. All actual-driver cases now share one owner and ordered fixture setup. Production was not involved in the original test race. Both authoritative PR #227 and mirror #73 must reference the corrected `09f156a` head.

## Reference evidence

The proposed live operator may read only the temporary observer service's own unrendered variable map inside reviewed, bounded code. It must never read the application's variables, shared variables, resolved deployment variables or raw variable responses through an agent-facing tool. No raw body, response, exception, variable key/value or credential may enter a console, file or tool result. The reducer accepts only the two exact expected source-service references. Unexpected inline values and additional keys are refused with a fixed code, without reflection.

A match proves only that the observed configuration contains those reference expressions at that time. It does not prove what an already-running observer loaded, prove equal credentials, establish the resolved endpoint's identity or establish live TLS connectivity. The approved source-service ID/name must be re-observed and matched independently; a service rename invalidates that binding. A later deployment boundary must bind the configuration observation to the particular observer image/run. Sealed/missing values fail closed; do not infer them. All reducer results preserve production HOLD.

## Deployment evidence

The source version proposal compares trusted, bounded projections of GitHub's Railway-created deployment record and Railway's active app deployment. It requires the expected owning identities/repository, exactly one active deployment, a matching successful source SHA, a bounded creation-time correlation, complete coverage with no later deployment, and fresh stable before/after observations.

The active deployment must also have been created no later than GitHub's success status for the selected record. A dashboard rollback, CLI deploy or redeploy creates a Railway deployment with no GitHub record of its own, so the newer commit's record stays the newest and successful; without this rule, one made within the skew window after a successful deploy would be attributed to the newer commit (found in Claude's review of #228; regression test in `assurance.test.ts`). Set `maxSkewMs` from the gap measured on the first authenticated read. Railway is expected to create its deployment and GitHub's record together, seconds apart; that is unmeasured, and the 10-minute ceiling is a bound, not a recommended setting.

The evidence grade is **deployment correlated, not running binary attested**. A provider-written GitHub record and time match are useful operational evidence, but there is no documented typed deployed-commit field being read here. A public health commit echo would still be a self-report. Approving that evidence grade for a specific read-only run is a separate founder decision; this module does not silently remove `deployed_commit_unverified` from the existing platform checker.

## Transport and secret custody

The reducers accept decoded unknown input for offline testing. A caller could fabricate that input; therefore reducer success alone is not authenticated evidence. The future trusted composition root must use independently approved resource IDs, fixed Railway HTTPS operations, secure credential substitution, no redirects or retries, complete bounded pagination, deadline handling, bounded response decoding and fixed-error suppression. It must reduce responses before returning anything to an agent. No general GraphQL, variable readback or arbitrary command capability is granted.

A secure connector entry card can protect credential entry; it does not make a Railway project token read-only and does not by itself constrain all operations. Verify the supported token-substitution path without exposing a real credential before enabling a live controller. Never disable token replacement to obtain a token value in this project. The token must not go into the observer, app, shell arguments, environment files or a build. No key is requested at this stage.

## Decision and future completion

Even a valid stored-reference result plus valid deployment correlation retains HOLD/live disabled. This increment is reducer logic and synthetic failure coverage, not the completed once-only live launcher. Remaining work: reviewed authenticated transport, immutable image build/provenance, correctly scoped destination, approved assurance grade, exact permissions, actual cost estimate and disposal/revocation receipts. The proposed one attempt/five-minute observation/30-minute resource lifetime/US$1 ceiling is not an approved resource or an enforceable provider cap.

New intake during observation is `no_go_incomplete_evidence`, not `no_go_unfinished_work`. Both block. Failed jobs and human-parked items remain reported; they are not automatically classified as running jobs. No data cleanup, retry, app replacement, freeze, export, restore or Shopify GO follows from this preparation.

References: https://docs.railway.com/variables ; official CLI schema snapshot `4a13c465c18097b362cbfbd632f016424d764de2` as documented in the predecessor platformIdentity module. Live resolver permissions remain untested.

## Final local validation

The exact final formatted source passed source types, explicit test types, lint/build and whitespace/credential-pattern screening. Focused observer suites: 534 passed / 4 fixture-gated skips. With fresh actual loopback MySQL/Redis fixtures: 538 passed / no skips. Full repository suite on a new synthetic MySQL database: 5,930 passed / 25 intentional skips (343 passed files / 4 skipped files). Committed migrations and drift passed; fixture processes/data were removed. Final static review found no approval-critical defect for draft submission. These are local synthetic results, not live provider evidence or GitHub CI claims.
