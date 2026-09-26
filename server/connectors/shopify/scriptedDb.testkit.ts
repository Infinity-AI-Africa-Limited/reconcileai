/**
 * TEST-ONLY. A scripted stand-in for the drizzle handle, shared by the Shopify
 * connector suites. Never imported by production code.
 *
 * Each query answers from a per-table queue the test scripts, and every
 * operation is recorded with its WHERE clause rendered to SQL and parameters,
 * so a test can assert what a write was actually conditioned on — the property
 * these fixes are about — rather than that some function was called.
 *
 * Transactions are modelled: operations carry the id of the transaction they
 * ran in, and a transaction whose callback throws is marked rolled back, so
 * `committed()` answers what a real database would have kept.
 */
import { getTableName, SQL, type Table } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();

export type OpKind = "select" | "insert" | "update" | "delete";

export interface RecordedOp {
  kind: OpKind;
  table: string;
  /** Rendered WHERE clause, when the operation had one. */
  where: { sql: string; params: unknown[] } | null;
  /** INSERT values or UPDATE set-clause, as passed. */
  data: Record<string, unknown> | Record<string, unknown>[] | null;
  /** Set when the INSERT carried ON DUPLICATE KEY UPDATE. */
  upsert: boolean;
  /** The transaction this ran in, or null outside one. */
  txId: number | null;
  /** Set on a locking read (`.for("update")`). */
  locked: boolean;
}

/** A scripted answer: rows for a select, affected rows for a write, or an error to throw. */
type Answer = unknown[] | number | Error;

export interface Script {
  /** Rows a select on the table returns whenever its queue below is empty. */
  standing?: Record<string, unknown[]>;
  select?: Record<string, Answer[]>;
  insert?: Record<string, Answer[]>;
  update?: Record<string, Answer[]>;
  delete?: Record<string, Answer[]>;
}

export interface ScriptedDb {
  /** Pass as the mocked `getDb()` result. */
  db: unknown;
  ops: RecordedOp[];
  /** Operations that were not inside a rolled-back transaction. */
  committed(): RecordedOp[];
  /** Committed operations of one kind on one table. */
  writes(kind: Exclude<OpKind, "select">, table: string): RecordedOp[];
}

export function scriptedDb(script: Script = {}): ScriptedDb {
  const ops: RecordedOp[] = [];
  const rolledBack = new Set<number>();
  let nextTxId = 1;
  let nextInsertId = 1000;

  const take = (kind: OpKind, table: string): Answer | undefined => script[kind]?.[table]?.shift();

  const render = (cond: unknown) => {
    if (!(cond instanceof SQL)) return null;
    const { sql, params } = dialect.sqlToQuery(cond);
    return { sql, params };
  };

  /** A thenable whose resolution is computed when it is awaited. */
  const settle = <T>(compute: () => T) => ({
    then(resolve: (value: T) => unknown, reject: (error: unknown) => unknown) {
      try {
        return Promise.resolve(compute()).then(resolve, reject);
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
    },
  });

  const handle = (txId: number | null): Record<string, unknown> => {
    const record = (op: Omit<RecordedOp, "txId" | "locked"> & { locked?: boolean }): RecordedOp => {
      const full = { ...op, locked: op.locked ?? false, txId };
      ops.push(full);
      return full;
    };

    const writeResult = (kind: OpKind, table: string) => {
      const answer = take(kind, table);
      if (answer instanceof Error) throw answer;
      const affected = typeof answer === "number" ? answer : 1;
      return [{ affectedRows: affected, insertId: 0 }, []];
    };

    return {
      select(_fields?: unknown) {
        let table = "";
        let where: RecordedOp["where"] = null;
        let locked = false;
        const query = {
          from(t: Table) { table = getTableName(t); return query; },
          innerJoin() { return query; },
          where(cond: unknown) { where = render(cond); return query; },
          orderBy() { return query; },
          limit() { return query; },
          for() { locked = true; return query; },
          ...settle(() => {
            record({ kind: "select", table, where, data: null, upsert: false, locked });
            const answer = take("select", table);
            if (answer instanceof Error) throw answer;
            return Array.isArray(answer) ? answer : (script.standing?.[table] ?? []);
          }),
        };
        return query;
      },

      insert(t: Table) {
        const table = getTableName(t);
        return {
          values(values: Record<string, unknown> | Record<string, unknown>[]) {
            let upsert = false;
            const compute = () => {
              record({ kind: "insert", table, where: null, data: values, upsert });
              const answer = take("insert", table);
              if (answer instanceof Error) throw answer;
              const insertId = typeof answer === "number" ? answer : nextInsertId++;
              return [{ affectedRows: 1, insertId }, []];
            };
            return {
              onDuplicateKeyUpdate() { upsert = true; return settle(compute); },
              ...settle(compute),
            };
          },
        };
      },

      update(t: Table) {
        const table = getTableName(t);
        return {
          set(data: Record<string, unknown>) {
            return {
              where(cond: unknown) {
                const where = render(cond);
                return settle(() => {
                  record({ kind: "update", table, where, data, upsert: false });
                  return writeResult("update", table);
                });
              },
            };
          },
        };
      },

      delete(t: Table) {
        const table = getTableName(t);
        return {
          where(cond: unknown) {
            const where = render(cond);
            return settle(() => {
              record({ kind: "delete", table, where, data: null, upsert: false });
              return writeResult("delete", table);
            });
          },
        };
      },

      async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        const id = nextTxId++;
        try {
          return await fn(handle(id));
        } catch (error) {
          rolledBack.add(id);
          throw error;
        }
      },
    };
  };

  const committed = () => ops.filter((op) => op.txId === null || !rolledBack.has(op.txId));
  return {
    db: handle(null),
    ops,
    committed,
    writes: (kind, table) => committed().filter((op) => op.kind === kind && op.table === table),
  };
}

/** A MySQL unique-key violation, wrapped the way drizzle-orm 0.44 wraps it. */
export function duplicateKeyError(): Error {
  const driverError = Object.assign(new Error("Duplicate entry 'SHP_X' for key 'organizations.code'"), {
    code: "ER_DUP_ENTRY",
    errno: 1062,
  });
  return Object.assign(new Error("Failed query: insert into `organizations` …\nparams: …"), { cause: driverError });
}
