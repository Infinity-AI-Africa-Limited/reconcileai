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
  /** The ON DUPLICATE KEY UPDATE set-clause, as passed. */
  onDuplicate?: Record<string, unknown>;
  /** The transaction this ran in, or null outside one. */
  txId: number | null;
  /** Set on a locking read (`.for("update")`). */
  locked: boolean;
  /**
   * The row ceiling a select asked for, when it asked for one.
   *
   * The fake answers from a scripted array and cannot apply a limit, so a test
   * that only reads the rows back proves nothing about the limit the real query
   * would send. A keyset pager that fetches one row beyond its page purely to
   * answer "is there more?" is exactly that case: drop the extra row and the
   * fake behaves identically while production always reports no further pages.
   */
  limit?: number;
}

/**
 * The single row a write carried, or null when an insert carried several.
 *
 * `data` is a row OR the rows of a bulk insert, so reading a field off it does
 * not type-check without narrowing first. Most assertions are about an update
 * or a one-row insert and want exactly this.
 */
export const rowOf = (op?: RecordedOp): Record<string, unknown> | null =>
  op && !Array.isArray(op.data) ? op.data : null;

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
  /**
   * The committed operations as JSON, for a scan asserting that no raw
   * identifier was persisted anywhere.
   *
   * `JSON.stringify(committed())` cannot do this: an upsert's set-clause holds
   * drizzle `SQL` values, and those reference their own table, so stringify
   * throws on the cycle. Here they are rendered to SQL text plus parameters —
   * which is what such a scan has to read anyway, since an identifier smuggled
   * into an upsert would sit in those parameters.
   */
  committedJson(): string;
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
        let limit: number | undefined;
        const query = {
          from(t: Table) { table = getTableName(t); return query; },
          innerJoin() { return query; },
          leftJoin() { return query; },
          where(cond: unknown) { where = render(cond); return query; },
          orderBy() { return query; },
          groupBy() { return query; },
          limit(rows?: number) { limit = rows; return query; },
          for() { locked = true; return query; },
          ...settle(() => {
            record({ kind: "select", table, where, data: null, upsert: false, locked, ...(limit === undefined ? {} : { limit }) });
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
            let onDuplicate: Record<string, unknown> | undefined;
            const compute = () => {
              record({ kind: "insert", table, where: null, data: values, upsert, ...(onDuplicate ? { onDuplicate } : {}) });
              const answer = take("insert", table);
              if (answer instanceof Error) throw answer;
              const insertId = typeof answer === "number" ? answer : nextInsertId++;
              return [{ affectedRows: 1, insertId }, []];
            };
            return {
              onDuplicateKeyUpdate(config?: { set?: Record<string, unknown> }) {
                upsert = true;
                onDuplicate = config?.set;
                return settle(compute);
              },
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
    committedJson: () => {
      const seen = new WeakSet<object>();
      return JSON.stringify(committed(), (_key, value: unknown) => {
        if (value instanceof SQL) {
          const query = dialect.sqlToQuery(value);
          return { sql: query.sql, params: query.params };
        }
        if (value && typeof value === "object") {
          if (seen.has(value)) return "[seen]";
          seen.add(value);
        }
        return value;
      });
    },
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
