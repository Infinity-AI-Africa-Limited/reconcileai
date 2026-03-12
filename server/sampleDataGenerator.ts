/**
 * Sample Data Generator for ReconcileAI
 * Generates realistic Nigerian banking transaction CSVs for testing the reconciliation engine.
 * Produces a SOURCE file and a TARGET file with configurable match rate, exception types, etc.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface SampleDataConfig {
  transactionCount: number;       // Number of source transactions (10-500)
  matchRate: number;              // Percentage of exact/near matches (0-100)
  sourceChannel: string;          // e.g. "nibss", "pos"
  targetChannel: string;          // e.g. "bank_transfer", "mobile_money"
  dateRangeStart: string;         // ISO date string
  dateRangeEnd: string;           // ISO date string
  includeAmountMismatches: boolean;
  includeTimingDifferences: boolean;
  includeMissingCounterparties: boolean;
  includeDuplicates: boolean;
}

interface GeneratedTransaction {
  reference: string;
  external_ref: string;
  date: string;
  amount: string;
  type: string;
  currency: string;
  description: string;
  counterparty: string;
  value_date: string;
}

// ─── Nigerian Banking Data ──────────────────────────────────────────

const NIGERIAN_BANKS = [
  "Access Bank", "Zenith Bank", "GTBank", "First Bank", "UBA",
  "Fidelity Bank", "Stanbic IBTC", "Sterling Bank", "Union Bank",
  "Wema Bank", "Polaris Bank", "Keystone Bank", "FCMB", "Ecobank",
];

const NIGERIAN_NAMES = [
  "Adebayo Ogundimu", "Chioma Nwosu", "Emeka Okafor", "Fatima Ibrahim",
  "Gbenga Adeyemi", "Halima Bello", "Ikenna Eze", "Jumoke Adesanya",
  "Kunle Bakare", "Lola Okonkwo", "Musa Abdullahi", "Ngozi Chukwu",
  "Oluwaseun Adeleke", "Patience Okoro", "Rasheed Lawal", "Sade Ogunleye",
  "Tunde Fashola", "Uche Nnamdi", "Victoria Adekunle", "Wale Oladipo",
  "Yetunde Alabi", "Zainab Mohammed", "Adeola Bamidele", "Bola Obasanjo",
  "Chidi Anyanwu", "Damilola Akinwale", "Ebere Onyekachi", "Folake Adeniyi",
];

const TRANSACTION_DESCRIPTIONS = [
  "Salary payment", "Vendor payment", "Utility bill", "Rent payment",
  "Insurance premium", "Loan repayment", "Service charge", "Commission payment",
  "Transfer to savings", "POS purchase", "ATM withdrawal", "Mobile top-up",
  "Internet subscription", "Fuel purchase", "Office supplies", "Equipment lease",
  "Consulting fee", "Marketing expense", "Travel reimbursement", "Tax payment",
  "Dividend payment", "Interest income", "Refund processing", "Payroll disbursement",
  "Customs duty", "Import payment", "Export proceeds", "Freight charges",
];

const CHANNEL_PREFIXES: Record<string, string> = {
  nibss: "NIP",
  pos: "POS",
  mobile_money: "MOB",
  atm: "ATM",
  bank_transfer: "TRF",
  agent_banking: "AGT",
  fintech_api: "FIN",
  card_payments: "CRD",
  core_banking: "CBS",
  neft: "NFT",
  ussd: "USD",
  bank_statement: "BST",
};

// Core banking specific transaction descriptions (loan, ledger, savings context)
const CBS_TRANSACTION_DESCRIPTIONS = [
  "Loan disbursement", "Loan repayment", "Interest accrual", "Principal repayment",
  "Savings deposit", "Savings withdrawal", "Account maintenance fee", "Ledger posting",
  "Product portfolio entry", "Loan account credit", "Loan account debit",
  "Interest income posting", "Fee income posting", "Reversal posting",
  "Contra entry", "GL transfer", "Product balance adjustment", "Accrued interest settlement",
  "Penalty charge", "Insurance premium deduction", "Collateral release",
  "Loan origination fee", "Processing fee", "Early repayment", "Partial repayment",
];

// ─── Utility Functions ──────────────────────────────────────────────

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number, decimals: number = 2): number {
  const val = Math.random() * (max - min) + min;
  return parseFloat(val.toFixed(decimals));
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateRef(prefix: string, index: number): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const seq = String(index).padStart(4, "0");
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}/${timestamp}${seq}${rand}`;
}

function randomDate(start: Date, end: Date): Date {
  const startTime = start.getTime();
  const endTime = end.getTime();
  return new Date(startTime + Math.random() * (endTime - startTime));
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function addDays(d: Date, days: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + days);
  return result;
}

// ─── Core Generator ─────────────────────────────────────────────────

export function generateSampleData(config: SampleDataConfig): {
  sourceCSV: string;
  targetCSV: string;
  summary: {
    sourceCount: number;
    targetCount: number;
    exactMatches: number;
    amountMismatches: number;
    timingDifferences: number;
    missingCounterparties: number;
    duplicates: number;
    unmatchedSource: number;
    unmatchedTarget: number;
  };
} {
  const startDate = new Date(config.dateRangeStart);
  const endDate = new Date(config.dateRangeEnd);
  const srcPrefix = CHANNEL_PREFIXES[config.sourceChannel] || "SRC";
  const tgtPrefix = CHANNEL_PREFIXES[config.targetChannel] || "TGT";

  const sourceTransactions: GeneratedTransaction[] = [];
  const targetTransactions: GeneratedTransaction[] = [];

  // Determine how many transactions fall into each category
  const totalSource = config.transactionCount;
  const matchedCount = Math.round(totalSource * (config.matchRate / 100));
  const unmatchedSourceCount = totalSource - matchedCount;

  // Split matched into sub-categories
  let exactMatchCount = matchedCount;
  let amountMismatchCount = 0;
  let timingDiffCount = 0;
  let missingCounterpartyCount = 0;
  let duplicateCount = 0;

  if (config.includeAmountMismatches && matchedCount > 4) {
    amountMismatchCount = Math.max(1, Math.round(matchedCount * 0.15));
    exactMatchCount -= amountMismatchCount;
  }
  if (config.includeTimingDifferences && matchedCount > 4) {
    timingDiffCount = Math.max(1, Math.round(matchedCount * 0.12));
    exactMatchCount -= timingDiffCount;
  }
  if (config.includeMissingCounterparties && unmatchedSourceCount > 2) {
    missingCounterpartyCount = Math.max(1, Math.round(unmatchedSourceCount * 0.3));
  }
  if (config.includeDuplicates && matchedCount > 4) {
    duplicateCount = Math.max(1, Math.round(matchedCount * 0.05));
    exactMatchCount -= duplicateCount;
  }

  let srcIdx = 0;
  let tgtIdx = 0;

  // Helper: pick description based on channel context
  const isCbsSource = config.sourceChannel === "core_banking";
  const isCbsTarget = config.targetChannel === "core_banking";
  const pickSrcDesc = () => isCbsSource ? randomChoice(CBS_TRANSACTION_DESCRIPTIONS) : randomChoice(TRANSACTION_DESCRIPTIONS);
  const pickTgtDesc = () => isCbsTarget ? randomChoice(CBS_TRANSACTION_DESCRIPTIONS) : randomChoice(TRANSACTION_DESCRIPTIONS);

  // 1. Generate exact matches
  for (let i = 0; i < exactMatchCount; i++) {
    const date = randomDate(startDate, endDate);
    const amount = randomFloat(500, 5000000, 2);
    const counterparty = randomChoice(NIGERIAN_NAMES);
    const bank = randomChoice(NIGERIAN_BANKS);
    const srcDesc = pickSrcDesc();
    const tgtDesc = isCbsSource || isCbsTarget ? srcDesc : randomChoice(TRANSACTION_DESCRIPTIONS);
    const ref = generateRef(srcPrefix, srcIdx);
    const debitCredit = Math.random() > 0.5 ? "credit" : "debit";

    sourceTransactions.push({
      reference: ref,
      external_ref: generateRef(tgtPrefix, tgtIdx),
      date: formatDate(date),
      amount: amount.toFixed(2),
      type: debitCredit,
      currency: "NGN",
      description: isCbsSource ? `${srcDesc} | Acct:${Math.floor(Math.random()*9000000+1000000)}` : `${srcDesc} - ${bank}`,
      counterparty,
      value_date: formatDate(addDays(date, randomInt(0, 1))),
    });

    targetTransactions.push({
      reference: generateRef(tgtPrefix, tgtIdx),
      external_ref: ref,
      date: formatDate(date),
      amount: amount.toFixed(2),
      type: debitCredit === "credit" ? "debit" : "credit",
      currency: "NGN",
      description: isCbsTarget ? `${tgtDesc} | Acct:${Math.floor(Math.random()*9000000+1000000)}` : `${tgtDesc} - ${bank}`,
      counterparty,
      value_date: formatDate(addDays(date, randomInt(0, 1))),
    });

    srcIdx++;
    tgtIdx++;
  }

  // 2. Generate amount mismatches (within 0.5-2.5% difference)
  for (let i = 0; i < amountMismatchCount; i++) {
    const date = randomDate(startDate, endDate);
    const amount = randomFloat(1000, 3000000, 2);
    const mismatchPct = randomFloat(0.006, 0.025, 4); // 0.6% to 2.5%
    const targetAmount = amount * (1 + (Math.random() > 0.5 ? mismatchPct : -mismatchPct));
    const counterparty = randomChoice(NIGERIAN_NAMES);
    const bank = randomChoice(NIGERIAN_BANKS);
    const desc = randomChoice(TRANSACTION_DESCRIPTIONS);
    const ref = generateRef(srcPrefix, srcIdx);
    const debitCredit = Math.random() > 0.5 ? "credit" : "debit";

    sourceTransactions.push({
      reference: ref,
      external_ref: generateRef(tgtPrefix, tgtIdx),
      date: formatDate(date),
      amount: amount.toFixed(2),
      type: debitCredit,
      currency: "NGN",
      description: `${desc} - ${bank}`,
      counterparty,
      value_date: formatDate(addDays(date, randomInt(0, 1))),
    });

    targetTransactions.push({
      reference: generateRef(tgtPrefix, tgtIdx),
      external_ref: ref,
      date: formatDate(date),
      amount: targetAmount.toFixed(2),
      type: debitCredit === "credit" ? "debit" : "credit",
      currency: "NGN",
      description: `${desc} - ${bank} (fee adjusted)`,
      counterparty,
      value_date: formatDate(addDays(date, randomInt(0, 1))),
    });

    srcIdx++;
    tgtIdx++;
  }

  // 3. Generate timing differences (4-9 day gap)
  for (let i = 0; i < timingDiffCount; i++) {
    const date = randomDate(startDate, addDays(endDate, -10));
    const amount = randomFloat(500, 2000000, 2);
    const dayGap = randomInt(4, 9);
    const counterparty = randomChoice(NIGERIAN_NAMES);
    const bank = randomChoice(NIGERIAN_BANKS);
    const desc = randomChoice(TRANSACTION_DESCRIPTIONS);
    const ref = generateRef(srcPrefix, srcIdx);
    const debitCredit = Math.random() > 0.5 ? "credit" : "debit";

    sourceTransactions.push({
      reference: ref,
      external_ref: generateRef(tgtPrefix, tgtIdx),
      date: formatDate(date),
      amount: amount.toFixed(2),
      type: debitCredit,
      currency: "NGN",
      description: `${desc} - ${bank}`,
      counterparty,
      value_date: formatDate(addDays(date, 1)),
    });

    targetTransactions.push({
      reference: generateRef(tgtPrefix, tgtIdx),
      external_ref: ref,
      date: formatDate(addDays(date, dayGap)),
      amount: amount.toFixed(2),
      type: debitCredit === "credit" ? "debit" : "credit",
      currency: "NGN",
      description: `${desc} - ${bank} (delayed settlement)`,
      counterparty,
      value_date: formatDate(addDays(date, dayGap + 1)),
    });

    srcIdx++;
    tgtIdx++;
  }

  // 4. Generate duplicates in target
  for (let i = 0; i < duplicateCount; i++) {
    const date = randomDate(startDate, endDate);
    const amount = randomFloat(1000, 1000000, 2);
    const counterparty = randomChoice(NIGERIAN_NAMES);
    const bank = randomChoice(NIGERIAN_BANKS);
    const desc = randomChoice(TRANSACTION_DESCRIPTIONS);
    const ref = generateRef(srcPrefix, srcIdx);
    const debitCredit = Math.random() > 0.5 ? "credit" : "debit";

    sourceTransactions.push({
      reference: ref,
      external_ref: generateRef(tgtPrefix, tgtIdx),
      date: formatDate(date),
      amount: amount.toFixed(2),
      type: debitCredit,
      currency: "NGN",
      description: `${desc} - ${bank}`,
      counterparty,
      value_date: formatDate(addDays(date, randomInt(0, 1))),
    });

    // Original target
    targetTransactions.push({
      reference: generateRef(tgtPrefix, tgtIdx),
      external_ref: ref,
      date: formatDate(date),
      amount: amount.toFixed(2),
      type: debitCredit === "credit" ? "debit" : "credit",
      currency: "NGN",
      description: `${desc} - ${bank}`,
      counterparty,
      value_date: formatDate(addDays(date, randomInt(0, 1))),
    });
    tgtIdx++;

    // Duplicate target
    targetTransactions.push({
      reference: generateRef(tgtPrefix, tgtIdx),
      external_ref: ref,
      date: formatDate(addDays(date, randomInt(0, 1))),
      amount: amount.toFixed(2),
      type: debitCredit === "credit" ? "debit" : "credit",
      currency: "NGN",
      description: `${desc} - ${bank} (duplicate)`,
      counterparty,
      value_date: formatDate(addDays(date, randomInt(0, 2))),
    });

    srcIdx++;
    tgtIdx++;
  }

  // 5. Generate unmatched source transactions
  for (let i = 0; i < unmatchedSourceCount; i++) {
    const date = randomDate(startDate, endDate);
    const amount = randomFloat(500, 4000000, 2);
    const bank = randomChoice(NIGERIAN_BANKS);
    const desc = randomChoice(TRANSACTION_DESCRIPTIONS);
    const ref = generateRef(srcPrefix, srcIdx);
    const debitCredit = Math.random() > 0.5 ? "credit" : "debit";

    const hasMissingCounterparty = i < missingCounterpartyCount;

    sourceTransactions.push({
      reference: ref,
      external_ref: "",
      date: formatDate(date),
      amount: amount.toFixed(2),
      type: debitCredit,
      currency: "NGN",
      description: `${desc} - ${bank}`,
      counterparty: hasMissingCounterparty ? "" : randomChoice(NIGERIAN_NAMES),
      value_date: formatDate(addDays(date, randomInt(0, 1))),
    });

    srcIdx++;
  }

  // 6. Generate some unmatched target transactions (extra noise)
  const unmatchedTargetCount = Math.max(1, Math.round(totalSource * 0.08));
  for (let i = 0; i < unmatchedTargetCount; i++) {
    const date = randomDate(startDate, endDate);
    const amount = randomFloat(500, 3000000, 2);
    const bank = randomChoice(NIGERIAN_BANKS);
    const desc = randomChoice(TRANSACTION_DESCRIPTIONS);
    const debitCredit = Math.random() > 0.5 ? "credit" : "debit";

    targetTransactions.push({
      reference: generateRef(tgtPrefix, tgtIdx),
      external_ref: "",
      date: formatDate(date),
      amount: amount.toFixed(2),
      type: debitCredit,
      currency: "NGN",
      description: `${desc} - ${bank}`,
      counterparty: randomChoice(NIGERIAN_NAMES),
      value_date: formatDate(addDays(date, randomInt(0, 2))),
    });

    tgtIdx++;
  }

  // Shuffle arrays for realism
  shuffle(sourceTransactions);
  shuffle(targetTransactions);

  // Convert to CSV
  const headers = "reference,external_ref,date,amount,type,currency,description,counterparty,value_date";
  const sourceCSV = [headers, ...sourceTransactions.map(txnToCSVRow)].join("\n");
  const targetCSV = [headers, ...targetTransactions.map(txnToCSVRow)].join("\n");

  return {
    sourceCSV,
    targetCSV,
    summary: {
      sourceCount: sourceTransactions.length,
      targetCount: targetTransactions.length,
      exactMatches: exactMatchCount,
      amountMismatches: amountMismatchCount,
      timingDifferences: timingDiffCount,
      missingCounterparties: missingCounterpartyCount,
      duplicates: duplicateCount,
      unmatchedSource: unmatchedSourceCount,
      unmatchedTarget: unmatchedTargetCount,
    },
  };
}

function txnToCSVRow(txn: GeneratedTransaction): string {
  return [
    escapeCSV(txn.reference),
    escapeCSV(txn.external_ref),
    txn.date,
    txn.amount,
    txn.type,
    txn.currency,
    escapeCSV(txn.description),
    escapeCSV(txn.counterparty),
    txn.value_date,
  ].join(",");
}

function escapeCSV(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
