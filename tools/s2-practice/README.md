# Synthetic S2 practice run

A rehearsal of the database recovery export, with **made-up data only**.
- It never connects to production, reads no production setting, and holds no production credential.
- **It is not an isolated environment, and must never be given a real credential or real data.** Its containers sit on Docker's default network with outbound access, its install is networked, several `S2_*` variables change what it runs, and its terminal relay (`pty_prompt.py`) sees everything the client prints.
- The owner approved it on 26 November 2026. It was revised on 28 November for the hosted limits Support stated.
- It is test-only: the pull request carrying it is never merged.

## The hosted rules it is built around

TiDB Cloud Support, 27 November 2026:
- **"Old data is kept for 10 minutes. This window can't be extended or held open, and we won't change it."**
  - Every read that must see the copy's point in time has to finish within 10 minutes of capturing that point. The practice plans for 8, from capture to the last such read.
  - The earlier idea of a held-open transaction stretching the window is withdrawn for this hosting.
- **No temporary read-only login exists.** The project login may also write.
- **Support's own profile:** one `mysqldump` connection with `--init-command="SET SESSION tidb_snapshot='<Position>'"`, where the Position is read from `SHOW MASTER STATUS`. An expired point fails with error 8055.

## What it found

1. **`mysqldump --single-transaction` cannot take a consistent snapshot of TiDB.**
   - `mysqldump` 8.4.13 (and 8.0.46) sends `UNLOCK TABLES` straight after `START TRANSACTION WITH CONSISTENT SNAPSHOT`, and TiDB ends the transaction there. TiDB's general log shows it.
   - Every table is then read separately, and the first `ROLLBACK TO SAVEPOINT` fails with error 1305.
   - That is the failure Support warned about. The method is withdrawn.
2. **A session pinned with `tidb_snapshot` refuses every write, even for a login that may write.**
   - INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER, TRUNCATE and DROP are all refused with error 1105, "can not execute write statement when 'tidb_snapshot' is set".
   - The same login, unpinned, can write. So the protection belongs to each session, not to the login, and **every operator session must be pinned**.
   - `START TRANSACTION READ ONLY` is not a substitute: TiDB refuses it as a no-op (error 1235).
   - **No write can safely test this on production.** TiDB checks the table and the grant before the pin: a pinned write to a missing table answers 1146, and one to a schema the login may not write answers 1142. Only a write that would change data if the pin failed reaches the pin's check. So never send a write to test it; confirm each session's pin by reading `@@tidb_snapshot`.
3. **The point must be copied as text.** A TSO is larger than a floating-point number holds exactly. Through a spreadsheet or JavaScript it comes back rounded:
   - rounded up, it is refused as "a future time";
   - rounded down, it silently names a different point.
4. **The profile's option order matters.** `--no-login-paths` must be the second argument, straight after `--no-defaults`; anywhere else, `mysqldump` rejects it.
5. **A copy can be validated with the stock client alone, so no custom tool ever holds the password.**
   - The validation script is written from column metadata only. For each table it has the server compute the row count and a digest of every row's SHA-256: every value as hex, NULL as `-` (`sqlDigestStatement` in `lib.mjs`).
   - Run in `mysql` pinned to the point and then against the restored copy, the two agree for every live table, and the digest tells the unpinned control copy apart.
   - It runs with `--skip-reconnect`, so a dropped connection ends the attempt instead of carrying on in a new session.

## What it proves, by quote option

**Option A — the live tables at one point, while writers keep running:**
- **The method:**
  - the point is captured with `SHOW MASTER STATUS`;
  - a pinned `mysqldump` exports the live tables, with the archive tables excluded and listed;
  - pinned sessions take per-table counts and full-row SHA-256 at the same point, both in Node (an independent check) and through the stock client's validation script (the method production would use);
  - **all of it inside the 8-minute budget, counted from capture.**
- **The result:** the restore into a separate target matches the source at the point in every table, schema, migrations watermark and per-organisation count. This held while a writer inserted, updated and deleted throughout.
- **The control:** a dump without the pin does not match, so the comparison can fail when it should.
- **Fail closed:** a point the server refuses stops `mysqldump` before it reads anything. A schema change after the point does not reach the dump.

**Option B — the whole database, archives included, under a writer freeze:**
- **Consistency comes from the freeze.** Every session is still pinned, to a fresh point each time, so that none of them can write.
- **The archives** are exported in primary-key ranges: the schema once, then data-only pieces, none of which can drop or create a table. A table without a single integer key stops for redesign; here, a small one is exported whole.
- **The result:** every table, and every table's schema, restores equal to the reference read at the start of the freeze.
  - The comparison is of whole tables, not of the planned ranges. A row in the copy outside every range, or a range missing from it, fails it; both are shown, then undone.
  - Here the reference is read at one point. If production's cannot be read inside one window, its reads span several points, and only the freeze makes them one.
- **A writer nobody stopped** (the Manus-hosted copy, for example) changes a row mid-freeze. The start-to-end comparison catches it, and that copy is INVALID.
  - It catches a write still present at the end, not one made and undone in between. So whether the freeze held is shown by evidence that every writer stopped, not by digests.

**Optional, slow (`gc_expiry.mjs`, about 25 minutes):**
- **The method:** it waits until garbage collection has passed a captured point, then runs the pinned export at that point.
- **Expected:** `mysqldump` refuses with error 8055 and leaves no completed file. The attempt is INVALID, and the partial file is deleted.
- **Observed on 28 November 2026:** garbage collection passed a point captured at 17:00:13 UTC about 19 minutes later. `mysqldump` then exited 2 at connect, before reading anything: "8055: snapshot is older than GC safe point". No completed file was left.

## What it does not prove

- **Starter itself.** The gateway, the real window, metering, the project login's grants, and whether Support's profile behaves there as described. That is the specialist's first trial, which needs its own approval because it touches production.
- **Production's size and speed.** Option A is viable only if the live scope's export and validation finish inside the budget. The 11 GiB historical estimate would need about 19.7 MB/s for 10 minutes before anything else, which is not a measurement.
- **The freeze itself.** Stopping every real writer, and proving they stopped, is an operational plan of its own.

## Running it

It needs Docker and Node 22 with the repository's dependencies installed. TiDB and MySQL images come from `mirror.gcr.io`.

```bash
tools/s2-practice/cluster.sh up /tmp/s2work
```

```bash
node tools/s2-practice/practice.mjs /tmp/s2work
```

```bash
node tools/s2-practice/gc_expiry.mjs /tmp/s2work
```

```bash
tools/s2-practice/cluster.sh down /tmp/s2work
```

`cluster.sh` starts PD, TiKV and a TiDB source (distributed storage, as on Starter), plus a separate TiDB target. Both serve TLS from a throwaway CA, and their ports are published on `127.0.0.1` only. That limits who can connect in; it does not stop the containers connecting out.

`practice.mjs` writes `receipt.json`, and `gc_expiry.mjs` writes `gc-expiry.json`. Each exits 0 only when every expected outcome was observed. `down` removes the containers, the network and the work directory.

The pure rules live in `lib.mjs` and are unit-tested by `tools/s2Practice.test.ts` in the normal CI run. The workflow `.github/workflows/s2-practice.yml` runs the practice whenever these files change. Dispatched with `gc_expiry` set, it also runs the slow demonstration. GitHub shows a Run button only for workflows on the default branch, but once a workflow has run, the API or GitHub CLI can dispatch it on this branch.
