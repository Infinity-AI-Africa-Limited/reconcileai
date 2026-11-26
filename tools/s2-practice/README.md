# Synthetic S2 practice run

A rehearsal of the database recovery export, with **made-up data only**. It never connects to production, reads no production setting, and holds no production credential. It was approved by the owner on 26 November 2026 as preparation for Card 3, and it is test-only: the pull request carrying it is never merged.

## What it found

**`mysqldump --single-transaction` cannot take a consistent snapshot of TiDB.** This is the S2 method the recovery plan had chosen. Support had warned on 3 November: "don't use --single-transaction, because it fails on this service".

The practice reproduces the failure on a plain TiDB v8.5.8 cluster, with MySQL 8.4.13's `mysqldump`, and shows the cause from TiDB's own general log:

1. `mysqldump` sends `START TRANSACTION WITH CONSISTENT SNAPSHOT`, then at once `UNLOCK TABLES`.
2. TiDB ends the transaction at `UNLOCK TABLES`. MySQL would not, so the client assumes it is still inside one.
3. Every table is then read in its own autocommit read: there is no single snapshot.
4. The first `ROLLBACK TO SAVEPOINT sp` then fails with error 1305. That error is what Support saw; the missing snapshot is the real problem.

`mysqldump` 8.0.46 fails the same way. The cause sits between the client and TiDB, not in the hosting, so it applies on TiDB Cloud Starter too.

## The method it proves instead

1. **A holding transaction fixes the snapshot.**
   - A read-only session runs `START TRANSACTION WITH CONSISTENT SNAPSHOT`, then reads its own `start_ts` with `SELECT @@tidb_current_ts`.
   - While it stays open, TiDB's garbage collection cannot pass that point.
2. **`mysqldump` reads at exactly that point.**
   - It runs with `--init-command="SET SESSION tidb_snapshot = '<start_ts>'"` and without `--single-transaction`.
   - Every statement it sends, schema included, reads at that snapshot.
   - If the snapshot cannot be set, `mysqldump` refuses to start.
3. **Same-snapshot validation runs inside the holding transaction:** per-table row counts and a full-row SHA-256, both at the same `start_ts`.
4. **The restore** runs into an isolated target, with the password typed at a terminal prompt and the SQL read from the file. The target is compared table by table.
5. **The holding transaction is then closed.** Its whole life must fit Starter's limits: 30 minutes per transaction, and no more than 340 seconds idle on the public endpoint. It keeps itself busy every 30 seconds.

**Archive tables** are exported separately, in primary-key ranges:
- the schema once, then data-only chunks, which can never drop or create a table;
- **each chunk at its own snapshot**, verified at that snapshot, then compared with the same range at one later reference snapshot.
- Equal hashes prove the restored archive equals the source at the reference point. No assumption that nothing wrote in between is needed.
- A range that changed is caught, and that copy is INVALID.
- A table with no single integer primary key stops for redesign.

## What it does not prove

- **Starter itself.** TiDB's limitations page does not restrict `tidb_snapshot` or `@@tidb_current_ts` on Starter, but only a run on the service shows they work there for a read-only user. That is the specialist's first trial (Card 3, Phase 0), which needs its own approval because it reads production data.
- **Production's size and timing.** This data is small. Production's export must be measured against the 30-minute and 340-second limits.
- **Garbage collection under a long hold.** TiDB documents that GC does not pass the start_ts of a running transaction (bounded by `tidb_gc_max_wait_time`). That needs a hold of more than 10 minutes, so it is not exercised here.
- **The managed gateway** in front of Starter, its connection handling and its metering.

## Running it

It needs Docker and Node 22 with the repository's dependencies installed. TiDB and MySQL images come from `mirror.gcr.io`.

```bash
tools/s2-practice/cluster.sh up /tmp/s2work
```

```bash
node tools/s2-practice/practice.mjs /tmp/s2work
```

```bash
tools/s2-practice/cluster.sh down /tmp/s2work
```

`cluster.sh` starts PD, TiKV and a TiDB source (distributed storage, as on Starter), plus a separate TiDB target. Both serve TLS from a throwaway CA, and nothing listens beyond `127.0.0.1`.

`practice.mjs` writes `receipt.json`. It exits 0 only when every expected outcome was observed, the deliberate failures included. `down` removes the containers, the network and the work directory with its synthetic dumps.

The pure rules live in `lib.mjs` and are unit-tested by `tools/s2Practice.test.ts` in the normal CI run. The full run has its own manual workflow, `.github/workflows/s2-practice.yml`.
