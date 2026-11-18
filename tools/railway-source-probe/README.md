# Railway source probe: a separate, non-production test

**Test-only. Never merge. This folder creates nothing by itself:** the repository, Railway
project and every step below need the owner's approval first.

## Why

On 18 November 2026 Railway's support declined to confirm four behaviours of the production
service (#238) and suggested this instead: *"a separate non-production project with its own
small repository. Give it a default branch and a second branch with different commits,
disable auto deploy the same way, and see which commit each action builds."*

Three production decisions depend on the answers:

| Production step | Railway action | What is unknown |
|---|---|---|
| Anthropic key replacement, before 28 November | a staged variable change, then **Deploy** | which commit it builds while no branch is connected |
| #242, and later Release 1 | **Deploy Latest Commit** | which commit it picks while no branch is connected |
| Turning automatic deploys back on | **Connect Environment to Branch** | whether it deploys at once, and what |

## What it can show, and what it cannot

It can show, for a new service in the same state (automatic deploys disabled the same way):

1. which commit **Deploy Latest Commit** builds;
2. which commit a staged variable change builds with a plain **Deploy**, whether that rebuilds
   or reuses the image, and whether the new value arrives;
3. whether **Redeploy** of the active deployment takes a variable committed without redeploying;
4. whether reconnecting a branch deploys at once.

It cannot show:

- **The legacy config-file state.** Railway's docs say "New services cannot opt into Config as
  Code", and its support would not confirm that a new service can reproduce production's state.
  So every result is **partial evidence**. Our reasoning, not proof: the commit is chosen
  before that commit's config file is read, so the file should not change which commit is chosen.
- Railway-initiated deployments (host moves, platform upgrades) or the 1 December cutoff.
- Anything about production's hosting, database, workload or shutdown.

**No result here is a production go-ahead by itself.**

## The fixture

The files in `fixture/` go, unchanged, at the root of the new repository. It is a zero-dependency
Node 22 HTTP server.
- **At start**, it logs one line and serves the same facts at `GET /`:
  - its source `MARKER`;
  - the time its image was built (written by the build step);
  - `PROBE_VARIABLE`, echoed only when it is a dummy such as `v2`;
  - Railway's `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_GIT_BRANCH`, `RAILWAY_DEPLOYMENT_ID` and
    `RAILWAY_SNAPSHOT_ID`.
- **It reads no other variable and opens no outbound connection.** It cannot print or send a
  secret, even one set on its service by mistake.

`tools/railwaySourceProbe.test.ts` proves all of this in CI. Each guarantee has been checked by
breaking it on purpose.

The marker in the code version (commit) and the commit Railway reports are two independent
readings. If they disagree, record both.

## Resources, cost, time and cleanup: for the owner's approval

| Item | Proposal |
|---|---|
| GitHub | One new **private** repository, `railway-source-probe`, default branch `main`. Recommended under `Infinity-AI-Africa-Limited`, so it uses the same Railway GitHub App installation as production. If that installation covers selected repositories only, the new one must be added: a GitHub organisation setting, owner action. Deleted at the end. |
| Railway | One new **project**, `source-probe`. **Not** a service or environment inside the ReconcileAI project. No database, Redis, volume or public domain. Deleted at the end. |
| Cost | Railway's pricing page: "Service builds are free"; memory $0.000231 per GB-minute, CPU $0.000463 per vCPU-minute. About 0.05 GB for at most 2 hours is about $0.0014 of memory; CPU is negligible. **Expected under $0.05**, inside the Hobby plan's included $5 if production leaves headroom. No plan change and no new payment method. |
| Time | 60–90 minutes of operator time. **Hard stop two hours after the project is created**, then clean up regardless. |
| Operator | Manus, in the browser, under the owner's approval. No token, CLI or API. |

## The exact sequence

`M1, M2, …` are commits on `main`; `S1, S2, …` are commits on a second branch, `side`. Each
commit changes only `MARKER` (to `main-2`, `side-2`, …) with the message `probe: <marker>`,
made in GitHub's web editor directly on its branch.

**Before each scenario, re-baseline so that three candidates differ:**
- the active deployment's commit;
- `main`'s head;
- the newest push anywhere in the repository, always made last, on `side`.

Each result then names exactly one of them.

### Setup

1. Create the repository with the fixture files. Commit **M1** (`main-1`).
2. Create branch `side` from M1 and commit **S1** (`side-1`).
3. Railway: **New Project → Deploy from GitHub repo →** `railway-source-probe`, branch `main`;
   name the project `source-probe`. **STOP if this flow is inside the ReconcileAI project.**
4. Add the variable `PROBE_VARIABLE=v1` and **Deploy** (automatic deploys are still on: setup only).
5. When Active, record the start line. Expect `marker=main-1 … probeVariable=v1 … railwayBranch=main`.
6. **Disable** automatic deployments with the same control used on production. Record the
   branch section's wording **immediately, and after a reload**. Production showed
   *Connect Environment to Branch* after a reload.
   - **If the test shows something else, STOP:** it does not reproduce production's state.
     Clean up and report.

### Scenario A: Deploy Latest Commit while unbound

7. Push **M2** to `main`, then **S2** to `side`. Confirm **no deployment starts**: evidence that
   Disable holds pushes. *Baseline: active M1 · main M2 · newest S2.*
8. Command palette → **Deploy Latest Commit**.
9. Record:
   - the commit on the card at Initializing;
   - whether Building follows;
   - the start line when Active.

| Result | Meaning |
|---|---|
| `main-2` | the Default branch's head (the documented reading) |
| `side-2` | the newest push on any branch: **unsafe** for production |
| `main-1` | the active deployment's code |
| nothing / an error | not available while unbound |

### Scenario B: a staged variable change, plain Deploy, while unbound

The closest match to the Anthropic key deployment.

10. Push **M3**, then **S3**. Record the active commit, left by Scenario A.
11. Change `PROBE_VARIABLE` to `v2`. Open the staged changes' **Details**: only this change. Click
    plain **Deploy**.
12. Record:
    - the commit at Initializing;
    - whether it builds (a Building phase, and `builtAt` changes) or reuses the image (`builtAt`
      unchanged);
    - `probeVariable`, expected `v2`.

| Commit built | Meaning |
|---|---|
| the active commit | redeploy semantics |
| `main-3` | the Default branch's head |
| `side-3` | the newest push: **unsafe** |

### Scenario C: commit the variable without redeploying, then Redeploy

13. Push **M4**, then **S4**.
14. Change `PROBE_VARIABLE` to `v3` and commit with **Alt + Deploy**. Confirm no deployment starts.
15. On the active deployment: **⋯ → Redeploy**. Record:
    - the commit;
    - Building or not, and `builtAt`;
    - `probeVariable`: `v3` means it takes the current variables, `v2` the original's.

    Railway documents Redeploy as "the exact same code and build/deploy configuration". Its
    pricing page says a Redeploy past retention rebuilds "with the deployment's original
    variables". This scenario settles which applies to an active deployment.

### Scenario D: reconnect

16. Push **M5**, then **S5**.
17. **Connect Environment to Branch → `main`.**
    - For three minutes, record whether a deployment starts, and its commit.
    - Reload and record the branch section.
18. If none started, push **M6** to `main` and record whether it deploys by itself, which means
    automatic deploys are back on.

### Cleanup: always, including after a STOP

19. Record the project's usage cost from Railway's usage page.
20. Delete the Railway project (**Project settings → Danger → Delete**). Confirm it is gone.
21. Delete the GitHub repository. If it was added to the Railway GitHub App's selected
    repositories, remove it.

## Stop conditions

Stop on any of these:

| Condition | Action |
|---|---|
| A screen shows the ReconcileAI project, service or environment | Stop before clicking anything |
| The state after Disable differs from production's (step 6) | Stop, clean up, report |
| A request for a token, payment method or plan change, or a usage estimate above $1 | Stop |
| A deployment appears in **production** at any point | Stop and report at once. Do not touch production |
| Two hours since the project was created | Clean up regardless |
| The card's commit and the log's marker disagree | Record both. Do not repeat a scenario to get a cleaner answer |

## Evidence to record

One row per scenario: time (WAT), action, the card's commit and message at Initializing,
Building seen (yes/no), final status, the start line, and the branch section's wording.
Screens of the test project only. No production screen, and no other project's Variables.

## How results map to production

| If | Then |
|---|---|
| B builds the active commit, or `main`'s head | The key's plain **Deploy** builds `4efaac2` in production as long as `main` stays at `4efaac2`, because both candidates are that commit. Keep the Initializing check. |
| B builds the newest push elsewhere | Do not use plain Deploy for the key. Use C's route if C takes the new variable; otherwise escalate before 28 November. |
| A deploys `main`'s head | **Deploy Latest Commit** is usable for #242 and Release 1, with `main`'s head confirmed first. |
| A deploys anything else, or fails | Release by reconnecting `main` (D), as a deliberate, approved release trigger. |
| D deploys at once | Reconnecting is a deployment: approve it as one. |

Every result is partial evidence (see "cannot"), weighed with the production-state risk in
the specific approval it supports.
