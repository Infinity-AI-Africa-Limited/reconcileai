/**
 * TEST-ONLY. An in-memory stand-in for the two tables an `appsubscription/paid`
 * delivery touches: the store's subscription row and its charge ledger. Never
 * imported by production code.
 *
 * Writes land and later reads see them, so a suite can deliver one charge
 * twice and read the count that results. A fake that answered each read from a
 * script could not do that: it would pass a handler that never records a
 * charge, because the script would say the charge had been recorded.
 *
 * Every statement must name the store AND its organisation, or the fake
 * throws. It models one store of one tenant and nothing else, so a statement
 * that loses either predicate would reach other tenants' rows in production.
 *
 * It does not model locks, isolation or a unique key under concurrency. Those
 * are real-engine behaviour, proven in billingChargeIdempotency.db.test.ts.
 */
import { getTableName, SQL, type Table } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SlConnectorBillingCharge, SlConnectorSubscription } from "../../../drizzle/connector_schema";

const dialect = new MySqlDialect();

export const SUBSCRIPTIONS = "sl_connector_subscriptions";
export const CHARGES = "sl_connector_billing_charges";

export interface LedgerStatement {
  kind: "select" | "insert" | "update";
  table: string;
  /** Set on a locking read (`.for("update")`). */
  locked: boolean;
  /** The transaction it ran in, or null outside one. */
  txId: number | null;
}

export interface BillingLedgerFake {
  /** Pass as the handler's `db`. */
  db: unknown;
  /** The subscription row as it now stands, or null when the store has none. */
  subscription(): SlConnectorSubscription | null;
  /** Every charge row, in the order first recorded. */
  charges(): SlConnectorBillingCharge[];
  statements: LedgerStatement[];
}

interface State {
  subscription: SlConnectorSubscription | null;
  charges: Map<string, SlConnectorBillingCharge>;
  nextChargeId: number;
}

export function billingLedgerFake(opts: {
  organizationId: number;
  slStoreId: number;
  /** The store's subscription row; null for a store that has none yet. */
  subscription: Partial<SlConnectorSubscription> | null;
}): BillingLedgerFake {
  const { organizationId, slStoreId } = opts;
  const created = new Date("2026-09-01T00:00:00.000Z");
  let state: State = {
    subscription:
      opts.subscription === null
        ? null
        : {
            id: 1,
            organizationId,
            slStoreId,
            shoplineSubscriptionId: "SUB-1",
            planId: "starter",
            status: "active",
            trialStartedAt: null,
            trialEndsAt: null,
            activatedAt: null,
            currentPeriodStart: null,
            currentPeriodEnd: null,
            cancelledAt: null,
            graceEndsAt: null,
            failedBillingAttempts: 0,
            lastFailureReason: null,
            createdAt: created,
            updatedAt: created,
            ...opts.subscription,
          },
    charges: new Map(),
    nextChargeId: 1,
  };
  const statements: LedgerStatement[] = [];
  let nextTxId = 1;

  const paramsOf = (cond: unknown): unknown[] => (cond instanceof SQL ? dialect.sqlToQuery(cond).params : []);

  /** The parameters of a WHERE that names this store and its tenant; throws otherwise. */
  const scoped = (table: string, cond: unknown): unknown[] => {
    const params = paramsOf(cond);
    if (!params.includes(slStoreId) || !params.includes(organizationId)) {
      throw new Error(`${table}: statement is not confined to store ${slStoreId} of organisation ${organizationId}`);
    }
    return params;
  };

  /** The charge a WHERE names: its one string parameter. */
  const chargeKey = (params: unknown[]): string => {
    const refs = params.filter((param): param is string => typeof param === "string");
    if (refs.length !== 1) throw new Error(`${CHARGES}: expected one bizOrderNo in the WHERE, found ${refs.length}`);
    return refs[0];
  };

  /** Plain values only: SQL expressions would need a database to evaluate. */
  const plain = <T extends Record<string, unknown>>(table: string, data: T): T => {
    for (const [key, value] of Object.entries(data)) {
      if (value instanceof SQL) throw new Error(`${table}.${key}: the fake cannot evaluate a SQL expression`);
    }
    return data;
  };

  const copy = (from: State): State => ({
    subscription: from.subscription ? { ...from.subscription } : null,
    charges: new Map([...from.charges].map(([key, row]) => [key, { ...row }])),
    nextChargeId: from.nextChargeId,
  });

  /** A thenable whose result is computed when it is awaited, as drizzle's builders are. */
  const settle = <T>(compute: () => T) => ({
    then(resolve: (value: T) => unknown, reject: (error: unknown) => unknown) {
      try {
        return Promise.resolve(compute()).then(resolve, reject);
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
    },
  });

  const handle = (txId: number | null): Record<string, unknown> => ({
    select() {
      let table = "";
      let where: unknown;
      let locked = false;
      const query = {
        from(t: Table) {
          table = getTableName(t);
          return query;
        },
        where(cond: unknown) {
          where = cond;
          return query;
        },
        limit() {
          return query;
        },
        for() {
          locked = true;
          return query;
        },
        ...settle(() => {
          statements.push({ kind: "select", table, locked, txId });
          const params = scoped(table, where);
          if (table === SUBSCRIPTIONS) return state.subscription ? [{ ...state.subscription }] : [];
          if (table === CHARGES) {
            const row = state.charges.get(chargeKey(params));
            return row ? [{ ...row }] : [];
          }
          throw new Error(`select from ${table} is not modelled`);
        }),
      };
      return query;
    },

    insert(t: Table) {
      const table = getTableName(t);
      return {
        values(values: Partial<SlConnectorBillingCharge>) {
          let upsert = false;
          const compute = () => {
            statements.push({ kind: "insert", table, locked: false, txId });
            if (table !== CHARGES) throw new Error(`insert into ${table} is not modelled`);
            if (values.organizationId !== organizationId || values.slStoreId !== slStoreId) {
              throw new Error(`${CHARGES}: insert is not for store ${slStoreId} of organisation ${organizationId}`);
            }
            const key = values.bizOrderNo;
            if (typeof key !== "string") throw new Error(`${CHARGES}: insert carries no bizOrderNo`);
            if (state.charges.has(key)) {
              // The unique key (slStoreId, bizOrderNo): only an upsert may meet an existing row.
              if (!upsert) throw new Error(`${CHARGES}: duplicate key ${key}`);
              return [{ affectedRows: 0, insertId: 0 }, []];
            }
            const id = state.nextChargeId++;
            state.charges.set(key, {
              id,
              organizationId,
              slStoreId,
              bizOrderNo: key,
              failureCountedAt: null,
              succeededAt: null,
              cancelledAt: null,
              deliveries: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...plain(CHARGES, values),
            });
            return [{ affectedRows: 1, insertId: id }, []];
          };
          return {
            onDuplicateKeyUpdate() {
              upsert = true;
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
              return settle(() => {
                statements.push({ kind: "update", table, locked: false, txId });
                const params = scoped(table, cond);
                if (table === SUBSCRIPTIONS) {
                  if (!state.subscription) return [{ affectedRows: 0 }, []];
                  Object.assign(state.subscription, plain(table, data));
                  return [{ affectedRows: 1 }, []];
                }
                if (table === CHARGES) {
                  const row = state.charges.get(chargeKey(params));
                  if (!row) return [{ affectedRows: 0 }, []];
                  Object.assign(row, plain(table, data));
                  return [{ affectedRows: 1 }, []];
                }
                throw new Error(`update of ${table} is not modelled`);
              });
            },
          };
        },
      };
    },

    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const before = copy(state);
      try {
        return await fn(handle(nextTxId++));
      } catch (error) {
        state = before;
        throw error;
      }
    },
  });

  return {
    db: handle(null),
    subscription: () => (state.subscription ? { ...state.subscription } : null),
    charges: () => [...state.charges.values()].map((row) => ({ ...row })),
    statements,
  };
}
