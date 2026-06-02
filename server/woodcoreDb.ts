/**
 * Woodcore (Fineract) test tenant MySQL connection helper.
 * Uses mysql2/promise with a connection pool.
 * Pool is recreated automatically on fatal connection errors.
 */
import mysql from "mysql2/promise";
import { ENV } from "./_core/env";

let pool: mysql.Pool | null = null;

function createPool(): mysql.Pool {
  return mysql.createPool({
    host: ENV.woodcoreDbHost,
    port: ENV.woodcoreDbPort,
    user: ENV.woodcoreDbUser,
    password: ENV.woodcoreDbPassword,
    database: ENV.woodcoreDbName,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 15000,
    // Allow connections from any IP — the MySQL user grant controls access
    multipleStatements: false,
  });
}

export function getWoodcorePool(): mysql.Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

export async function woodcoreQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  try {
    const p = getWoodcorePool();
    const [rows] = await p.execute(sql, params);
    return rows as T[];
  } catch (err: unknown) {
    // If the pool has gone stale (e.g. server restarted), recreate it and retry once
    const code = (err as { code?: string }).code;
    if (code === "ECONNRESET" || code === "PROTOCOL_CONNECTION_LOST" || code === "ECONNREFUSED") {
      pool = null;
      const p = getWoodcorePool();
      const [rows] = await p.execute(sql, params);
      return rows as T[];
    }
    throw err;
  }
}

// ─── Enum maps (derived from r_enum_value) ───────────────────────────────────

export const SAVINGS_TXN_TYPE: Record<number, string> = {
  0: "Invalid",
  1: "Deposit",
  2: "Withdrawal",
  3: "Interest Posting",
  4: "Withdrawal Fee",
  5: "Annual Fee",
  6: "Waive Charge",
  7: "Pay Charge",
  8: "Dividend Payout",
  12: "Initiate Transfer",
  13: "Approve Transfer",
  14: "Withdraw Transfer",
  15: "Reject Transfer",
  16: "Written-Off",
  17: "Overdraft Interest",
  19: "Withhold Tax",
};

export const LOAN_TXN_TYPE: Record<number, string> = {
  0: "Invalid",
  1: "Disbursement",
  2: "Repayment",
  3: "Contra",
  4: "Waive Interest",
  5: "Repayment at Disbursement",
  6: "Write-Off",
  7: "Marked for Rescheduling",
  8: "Recovery Repayment",
  9: "Waive Charges",
  10: "Accrual",
  12: "Initiate Transfer",
  13: "Approve Transfer",
  14: "Withdraw Transfer",
  15: "Reject Transfer",
  16: "Refund",
  17: "Charge Payment",
  18: "Refund for Active Loan",
  19: "Income Posting",
  20: "Accrual",
  21: "Charge-Off",
  22: "Accrual Activity",
};

export const GL_ENTRY_TYPE: Record<number, string> = {
  1: "DEBIT",
  2: "CREDIT",
};
