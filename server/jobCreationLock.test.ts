/**
 * Reconciliation jobs are created under their tenant's lock.
 *
 * The demo-timeline roll shifts a tenant's whole timeline while holding the
 * tenant's `organizations` row lock, and defers while a run is live. Without
 * job creation taking the same lock, a run created mid-roll would reconcile
 * over dates moving underneath it — review found three variants of that race
 * before the lock closed it. These tests pin both halves: the creator takes
 * the lock first, and nothing else writes a live job.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getTableName } from "drizzle-orm";
import { insertJobUnderTenantLock } from "./db";

function fakeDb() {
  const log: string[] = [];
  const tx = {
    select: () => {
      let table = "";
      const q = {
        from(t: Parameters<typeof getTableName>[0]) { table = getTableName(t); return q; },
        where() { return q; },
        for(strength: string) { log.push(`lock ${table} ${strength}`); return Promise.resolve([{ id: 1 }]); },
      };
      return q;
    },
    insert: (t: Parameters<typeof getTableName>[0]) => ({
      values: async () => { log.push(`insert ${getTableName(t)}`); return [{ insertId: 4242 }]; },
    }),
  };
  const db = {
    async transaction<T>(fn: (t: typeof tx) => Promise<T>) { log.push("begin"); const r = await fn(tx); log.push("commit"); return r; },
  };
  return { db: db as unknown as Parameters<typeof insertJobUnderTenantLock>[0], log };
}

const job = (organizationId: number | null) =>
  ({ userId: 1, organizationId, name: "run", dateFrom: new Date(), dateTo: new Date(), status: "pending" }) as Parameters<typeof insertJobUnderTenantLock>[1];

describe("when a reconciliation job is created", () => {
  it("should take the tenant's organisations lock before inserting, in one transaction", async () => {
    const { db, log } = fakeDb();
    expect(await insertJobUnderTenantLock(db, job(30001))).toBe(4242);
    expect(log).toEqual(["begin", "lock organizations update", "insert reconciliation_jobs", "commit"]);
  });

  it("should take no lock for a job with no organisation, which no roll can target", async () => {
    const { db, log } = fakeDb();
    await insertJobUnderTenantLock(db, job(null));
    expect(log).toEqual(["begin", "insert reconciliation_jobs", "commit"]);
  });
});

describe("when anything writes a reconciliation job", () => {
  // Every writer of reconciliation_jobs rows, by file. A new one must either go
  // through insertJobUnderTenantLock or be shown never to write a live job.
  const ALLOWED: Record<string, string> = {
    "server/db.ts": "insertJobUnderTenantLock itself",
    "server/demoSeedEngine.ts": "seeds COMPLETED historical runs only",
    "server/demoSeedFinServ.ts": "seeds a COMPLETED historical run only",
  };
  const ROOT = path.resolve(__dirname, "..");

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sources(full);
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
    });
  }

  it("should do so only through the locked creator, or a seeder of completed runs", () => {
    const writers = sources(path.join(ROOT, "server"))
      .filter((f) => /\.insert\(\s*(schema\.)?reconciliationJobs\s*\)/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .sort();
    expect(writers.length, "found no writers at all — has the pattern moved?").toBeGreaterThan(0);
    expect(writers).toEqual(Object.keys(ALLOWED).sort());
  });

  /** The argument text of every `.insert(reconciliationJobs).values(...)`, parentheses balanced. */
  function jobValues(src: string): string[] {
    const out: string[] = [];
    const re = /\.insert\(\s*reconciliationJobs\s*\)\s*\.values\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let depth = 1;
      let i = re.lastIndex;
      while (i < src.length && depth > 0) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
        i++;
      }
      out.push(src.slice(re.lastIndex, i - 1));
    }
    return out;
  }

  it("should keep the seeders writing completed runs, the condition of their exemption", () => {
    for (const file of ["server/demoSeedEngine.ts", "server/demoSeedFinServ.ts"]) {
      const inserts = jobValues(readFileSync(path.join(ROOT, file), "utf8"));
      expect(inserts.length, `${file} no longer inserts a job — drop its exemption`).toBeGreaterThan(0);
      for (const values of inserts) expect(values, file).toMatch(/status:\s*"completed"/);
    }
  });

  it("should insert a job in db.ts only inside insertJobUnderTenantLock", () => {
    const src = readFileSync(path.join(ROOT, "server/db.ts"), "utf8").replace(/\r\n/g, "\n");
    const start = src.indexOf("export async function insertJobUnderTenantLock(");
    const end = src.indexOf("\n}\n", start);
    const inside = src.slice(start, end);
    const outside = src.slice(0, start) + src.slice(end);
    expect(inside).toMatch(/\.insert\(reconciliationJobs\)/);
    expect(outside).not.toMatch(/\.insert\(reconciliationJobs\)/);
  });
});
