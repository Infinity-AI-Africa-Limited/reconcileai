/** TEST ONLY. Actual Drizzle SQL construction, evaluated over synthetic arrays.
 * No SQL driver, URL, sockets, fixtures on a real database, or runtime services.
 */
import { drizzle } from "drizzle-orm/mysql-proxy";
import type { getDb } from "../../db";

type RecordRow = Record<string, unknown>;
export type CaseFixture = {
  stores: RecordRow[]; organizations: RecordRow[]; channels: RecordRow[];
  transactions: RecordRow[]; exceptions: RecordRow[];
};
export function caseFixture(): CaseFixture {
  const evidence = { amount: "9999999999999999.99", currency: "USD", transactionDate: "2026-01-02 00:00:00", shopifyRefundId: "", transactionRef: "gid://shopify/Order/123", rawData: { email: "private@example.invalid" } };
  const exception = { category: "unmatched", severity: "high", status: "open", createdAt: "2026-01-03 00:00:00", description: "private@example.invalid", aiAnalysis: "RAW SECRET", jobId: 0 };
  return {
    stores: [7, 8, 9].map((id, i) => ({ id, organizationId: i === 2 ? 99 : 42, shopDomain: `store${id}.myshopify.com`, status: "active", privacyRedactionState: "active" })),
    organizations: [42, 99].map(id => ({ id, isActive: true, deletionState: "active" })),
    channels: [7, 8, 9].flatMap((id, i) => [
      { id: id * 10, organizationId: i === 2 ? 99 : 42, code: `shopify_orders_${id}` },
      { id: id * 10 + 1, organizationId: i === 2 ? 99 : 42, code: `shopify_settlement_evidence_${id}` },
    ]),
    transactions: [
      { ...evidence, id: 1, organizationId: 42, channelId: 70, shopifyStoreId: 7 },
      { ...evidence, id: 2, organizationId: 42, channelId: 70, shopifyStoreId: 7, shopifyRefundId: "gid://shopify/Refund/1" },
      { ...evidence, id: 3, organizationId: 42, channelId: 71, shopifyStoreId: null },
      { ...evidence, id: 4, organizationId: 42, channelId: 80, shopifyStoreId: 8 },
      { ...evidence, id: 5, organizationId: 42, channelId: 81, shopifyStoreId: null },
      { ...evidence, id: 6, organizationId: 99, channelId: 90, shopifyStoreId: 9 },
      { ...evidence, id: 7, organizationId: 99, channelId: 70, shopifyStoreId: 7 },
      { ...evidence, id: 8, organizationId: 42, channelId: 70, shopifyStoreId: 8 },
      { ...evidence, id: 9, organizationId: 42, channelId: 999, shopifyStoreId: 7 },
    ],
    exceptions: Array.from({ length: 11 }, (_, i) => ({ ...exception, id: i + 1, organizationId: i === 9 || i === 5 ? 99 : 42, transactionId: i === 9 ? 1 : i + 1 })),
  };
}

/** Interpret only the predicate vocabulary these read queries use. Unknown SQL
 * fails the test rather than silently accepting a predicate we did not model.
 */
function matches(where: string, params: unknown[], row: RecordRow): boolean {
  const tokens = where.match(/`[^`]+`\.`[^`]+`|\?|<>|=|\(|\)|,|\b(?:and|or|in|false|true)\b/gi) ?? [];
  let index = 0; let param = 0;
  const value = (): unknown => {
    const token = tokens[index++];
    if (token === "?") return params[param++];
    if (token?.startsWith("`")) return row[token.replaceAll("`", "")];
    throw new Error(`Unsupported mock token ${token}`);
  };
  const atom = (): boolean => {
    if (tokens[index] === "(") { index++; const result = disjunction(); if (tokens[index++] !== ")") throw new Error("Unclosed predicate"); return result; }
    if (tokens[index] === "false" || tokens[index] === "true") return tokens[index++] === "true";
    const left = value(); const operator = tokens[index++];
    if (operator === "in") {
      if (tokens[index++] !== "(") throw new Error("Bad IN");
      const values: unknown[] = [value()];
      while (tokens[index] === ",") { index++; values.push(value()); }
      if (tokens[index++] !== ")") throw new Error("Bad IN end");
      return left !== null && values.includes(left);
    }
    const right = value();
    if (operator !== "=" && operator !== "<>") throw new Error("Unsupported predicate");
    return left !== null && left !== undefined && (operator === "=" ? left === right : left !== right);
  };
  const conjunction = (): boolean => { let result = atom(); while (tokens[index] === "and") { index++; const next = atom(); result = result && next; } return result; };
  const disjunction = (): boolean => { let result = conjunction(); while (tokens[index] === "or") { index++; const next = conjunction(); result = result || next; } return result; };
  const result = disjunction();
  if (index !== tokens.length || param !== params.length) throw new Error("Mock did not consume predicate");
  return result;
}
const qualify = (table: string, row: RecordRow) => Object.fromEntries(Object.entries(row).map(([key, value]) => [`${table}.${key}`, value]));
export function casesDb(data = caseFixture()) {
  const queries: Array<{ sql: string; params: unknown[]; transaction: number }> = [];
  let transaction = 0;
  let outage = false;
  const db = drizzle(async (sql, params) => {
    if (outage) throw new Error("RAW SQL private@example.invalid credential detail");
    queries.push({ sql, params, transaction });
    if (!sql.startsWith("select ") || transaction === 0) throw new Error("Only transactional reads allowed");
    const where = sql.split(" where ")[1]?.split(/ order by | limit /)[0];
    if (!where) throw new Error("Missing WHERE");
    const prefix = sql.split(" where ")[0];
    const prefixCount = (prefix.match(/\?/g) ?? []).length;
    const whereCount = (where.match(/\?/g) ?? []).length;
    const condition = (row: RecordRow) => matches(where, params.slice(prefixCount, prefixCount + whereCount), row);
    if (sql.includes("from `shopify_connector_stores`")) {
      if (!sql.includes("`organizations`.`id` = `shopify_connector_stores`.`organizationId`")) throw new Error("Store tenant join missing");
      return { rows: data.stores.filter(store => data.organizations.some(org => org.id === store.organizationId && condition({ ...qualify("shopify_connector_stores", store), ...qualify("organizations", org) }))).map(store => [store.id]) };
    }
    if (sql.includes("from `channels`")) return { rows: data.channels.filter(channel => condition(qualify("channels", channel))).map(channel => [channel.id, channel.code]) };
    if (!sql.includes("inner join `transactions` on `transactions`.`id` = `exceptions`.`transactionId`")) throw new Error("Primary transaction join missing");
    const joined = data.exceptions.flatMap(exception => data.transactions.filter(tx => tx.id === exception.transactionId).map(tx => ({ exception, tx, row: { ...qualify("exceptions", exception), ...qualify("transactions", tx) } }))).filter(({ row }) => condition(row));
    if (sql.startsWith("select count(*)")) return { rows: [[joined.length]] };
    if (!sql.startsWith("select `exceptions`.`id`, `exceptions`.`category`, `exceptions`.`severity`, `exceptions`.`status`, `exceptions`.`createdAt`, `transactions`.`amount`, `transactions`.`currency`, `transactions`.`transactionDate`, case when ")) throw new Error("Unsafe/missing projection");
    if (/rawData|description|aiAnalysis|transactionRef|externalRef|userId/.test(prefix)) throw new Error("Unsafe projection");
    const limit = Number(params[prefixCount + whereCount]);
    const offset = Number(params[prefixCount + whereCount + 1] ?? 0);
    const settlement = prefixCount ? params[0] : undefined;
    return { rows: joined.sort((a, b) => String(b.exception.createdAt).localeCompare(String(a.exception.createdAt)) || Number(b.exception.id) - Number(a.exception.id)).slice(offset, offset + limit).map(({ exception: e, tx }) => [e.id, e.category, e.severity, e.status, e.createdAt, tx.amount, tx.currency, tx.transactionDate, tx.channelId === settlement ? "merchant_settlement" : tx.shopifyRefundId ? "shopify_refund" : "shopify_order"]) };
  });
  Object.defineProperty(db, "transaction", { value: async <T>(run: (tx: unknown) => Promise<T>, config: unknown) => {
    if (JSON.stringify(config) !== '{"isolationLevel":"repeatable read"}') throw new Error("Snapshot missing");
    transaction++;
    try { return await run(db); } finally { transaction--; }
  } });
  return { db: db as unknown as NonNullable<Awaited<ReturnType<typeof getDb>>>, data, queries, setOutage() { outage = true; } };
}
