/**
 * ReconcileAI — FinServ Demo Data Seed Script
 * Seeds all Nigerian financial services payment rails with realistic transaction data
 * at a 90–95% match rate, plus the Distributor Identity Registry.
 *
 * Run: node seed-finserv.mjs
 */

import mysql from "mysql2/promise";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomAmount(min, max) {
  return (Math.random() * (max - min) + min).toFixed(2);
}

function randomDate(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function nipSessionId() {
  // Nigerian NIP session ID format: YYYYMMDDHHMMSS + 6 random digits
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${String(randInt(100000,999999))}`;
}

function rrn() {
  // Retrieval Reference Number: 12 digits
  return String(randInt(100000000000, 999999999999));
}

function stan() {
  // System Trace Audit Number: 6 digits
  return String(randInt(100000, 999999));
}

function terminalId() {
  return `TRM${String(randInt(10000000, 99999999))}`;
}

function merchantId() {
  return `MER${String(randInt(1000000000, 9999999999))}`;
}

function accountNumber() {
  return String(randInt(1000000000, 9999999999));
}

function bvn() {
  return String(randInt(10000000000, 99999999999));
}

function nuban(bankCode) {
  const acct = String(randInt(1000000000, 9999999999));
  return acct;
}

// ─── Reference Data ──────────────────────────────────────────────────────────

const NIGERIAN_BANKS = [
  { name: "Guaranty Trust Bank", code: "058", shortName: "GTBank" },
  { name: "Access Bank", code: "044", shortName: "Access" },
  { name: "Zenith Bank", code: "057", shortName: "Zenith" },
  { name: "United Bank for Africa", code: "033", shortName: "UBA" },
  { name: "First Bank of Nigeria", code: "011", shortName: "FirstBank" },
  { name: "Fidelity Bank", code: "070", shortName: "Fidelity" },
  { name: "Union Bank", code: "032", shortName: "Union" },
  { name: "Sterling Bank", code: "232", shortName: "Sterling" },
  { name: "Wema Bank", code: "035", shortName: "Wema" },
  { name: "Stanbic IBTC", code: "221", shortName: "Stanbic" },
  { name: "Ecobank Nigeria", code: "050", shortName: "Ecobank" },
  { name: "Polaris Bank", code: "076", shortName: "Polaris" },
  { name: "Keystone Bank", code: "082", shortName: "Keystone" },
  { name: "Globus Bank", code: "103", shortName: "Globus" },
  { name: "Kuda Bank", code: "090267", shortName: "Kuda" },
  { name: "Opay", code: "999992", shortName: "Opay" },
  { name: "Moniepoint MFB", code: "090405", shortName: "Moniepoint" },
  { name: "PalmPay", code: "999991", shortName: "PalmPay" },
];

const NIGERIAN_STATES = [
  "Lagos", "Abuja", "Kano", "Rivers", "Ogun", "Oyo", "Anambra", "Delta", "Kaduna", "Enugu"
];

const FMCG_COMPANIES = [
  "Nestle Nigeria", "Unilever Nigeria", "Dangote Industries", "PZ Cussons Nigeria",
  "Cadbury Nigeria", "Nigerian Breweries", "Guinness Nigeria", "Flour Mills Nigeria",
  "BUA Foods", "Honeywell Flour Mills"
];

const DISTRIBUTOR_NAMES = [
  { canonical: "Adekunle Trading Enterprises", variants: ["Adekunle Trading", "ATE Ltd", "Adekunle Enterprises"] },
  { canonical: "Balogun General Merchants", variants: ["Balogun Merchants", "BGM Nigeria", "Balogun & Sons"] },
  { canonical: "Chukwuemeka Distributors Ltd", variants: ["Chukwuemeka Dist", "CDL Nigeria", "Emeka Distributors"] },
  { canonical: "Danjuma Commercial Ventures", variants: ["Danjuma Ventures", "DCV Ltd", "Danjuma Comm"] },
  { canonical: "Emeka & Sons Trading Co", variants: ["Emeka Sons Trading", "EST Co", "Emeka Trading"] },
  { canonical: "Fashola Wholesale Supplies", variants: ["Fashola Wholesale", "FWS Ltd", "Fashola Supplies"] },
  { canonical: "Garba Integrated Services", variants: ["Garba Services", "GIS Nigeria", "Garba Integrated"] },
  { canonical: "Hassan Brothers Distributors", variants: ["Hassan Brothers", "HBD Ltd", "Hassan Dist"] },
  { canonical: "Ifeoma Nwachukwu Enterprises", variants: ["Ifeoma Enterprises", "INE Ltd", "Nwachukwu Trading"] },
  { canonical: "Jubilee Merchants Nigeria", variants: ["Jubilee Merchants", "JMN Ltd", "Jubilee Nigeria"] },
  { canonical: "Kalu & Associates Trading", variants: ["Kalu Associates", "KAT Ltd", "Kalu Trading"] },
  { canonical: "Lagos Central Distributors", variants: ["Lagos Central Dist", "LCD Nigeria", "Central Distributors Lagos"] },
  { canonical: "Musa Abubakar Wholesale", variants: ["Musa Wholesale", "MAW Ltd", "Abubakar Wholesale"] },
  { canonical: "Nnamdi Okeke Supplies", variants: ["Nnamdi Supplies", "NOS Ltd", "Okeke Supplies"] },
  { canonical: "Okafor Brothers Merchants", variants: ["Okafor Brothers", "OBM Ltd", "Okafor Merchants"] },
  { canonical: "Pinnacle Distribution Services", variants: ["Pinnacle Dist", "PDS Nigeria", "Pinnacle Services"] },
  { canonical: "Quality First Distributors", variants: ["Quality First", "QFD Ltd", "Quality Distributors"] },
  { canonical: "Raji Integrated Merchants", variants: ["Raji Merchants", "RIM Ltd", "Raji Integrated"] },
  { canonical: "Sunshine Trading Enterprises", variants: ["Sunshine Trading", "STE Ltd", "Sunshine Enterprises"] },
  { canonical: "Tunde Adeyemi & Co", variants: ["Tunde Adeyemi", "TAC Ltd", "Adeyemi Trading"] },
  { canonical: "Uche Nwosu Distributors", variants: ["Uche Distributors", "UND Ltd", "Nwosu Dist"] },
  { canonical: "Victory Wholesale Nigeria", variants: ["Victory Wholesale", "VWN Ltd", "Victory Nigeria"] },
  { canonical: "Wale Ogundimu Supplies", variants: ["Wale Supplies", "WOS Ltd", "Ogundimu Trading"] },
  { canonical: "Xcel Distribution Network", variants: ["Xcel Distribution", "XDN Ltd", "Xcel Network"] },
  { canonical: "Yakubu Traders Association", variants: ["Yakubu Traders", "YTA Ltd", "Yakubu Assoc"] },
  { canonical: "Zara Commercial Enterprises", variants: ["Zara Commercial", "ZCE Ltd", "Zara Enterprises"] },
  { canonical: "Abuja Metro Distributors", variants: ["Abuja Metro", "AMD Ltd", "Metro Distributors Abuja"] },
  { canonical: "Benin City Wholesale Hub", variants: ["Benin Wholesale", "BCW Hub", "Benin City Hub"] },
  { canonical: "Calabar Trading Alliance", variants: ["Calabar Alliance", "CTA Ltd", "Calabar Traders"] },
  { canonical: "Delta State Merchants Co-op", variants: ["Delta Merchants", "DSMC Ltd", "Delta Co-op"] },
];

const ZONES = [
  "Lagos Zone A", "Lagos Zone B", "Lagos Zone C",
  "South-West Zone", "South-East Zone", "South-South Zone",
  "North-Central Zone", "North-West Zone", "North-East Zone",
  "Abuja FCT Zone"
];

// ─── Main Seed Function ──────────────────────────────────────────────────────

async function seed() {
  const conn = await mysql.createConnection(DB_URL);
  console.log("✅ Connected to database");

  try {
    // ── 1. Get or create demo organization ──────────────────────────────────
    const [orgs] = await conn.execute("SELECT id FROM organizations WHERE code = 'GLOBUS_DEMO' LIMIT 1");
    let orgId;
    if (orgs.length === 0) {
      const [result] = await conn.execute(
        `INSERT INTO organizations (name, code, country, baseCurrency, isActive, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
        ["Globus Bank Nigeria (Demo)", "GLOBUS_DEMO", "NGA", "NGN", 1]
      );
      orgId = result.insertId;
      console.log(`✅ Created demo organization: id=${orgId}`);
    } else {
      orgId = orgs[0].id;
      console.log(`✅ Using existing organization: id=${orgId}`);
    }

    // ── 2. Get admin user ────────────────────────────────────────────────────
    const [adminUsers] = await conn.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (adminUsers.length === 0) {
      console.error("❌ No admin user found. Please log in to the app first.");
      process.exit(1);
    }
    const adminUserId = adminUsers[0].id;
    console.log(`✅ Using admin user: id=${adminUserId}`);

    // Update admin user's organizationId if not set
    await conn.execute(
      "UPDATE users SET organizationId = ? WHERE id = ? AND organizationId IS NULL",
      [orgId, adminUserId]
    );

    // ── 3. Create / ensure all FinServ channels ──────────────────────────────
    const channelDefs = [
      {
        name: "NIBSS NIP (Instant Payments)",
        code: "NIBSS_NIP",
        channelType: "nibss",
        description: "NIBSS Instant Payment (NIP) — real-time interbank transfers via NIP rails",
        matchingConfig: JSON.stringify({ amountTolerance: 0, dateWindowDays: 1, primaryRef: "nipSessionId", secondaryRef: "rrn" }),
        fileFormat: JSON.stringify({ columns: ["sessionId", "rrn", "amount", "senderBank", "receiverBank", "narration", "transactionDate", "status"] }),
      },
      {
        name: "POS Transactions (Interswitch)",
        code: "POS_INTERSWITCH",
        channelType: "pos",
        description: "Point-of-Sale transactions settled via Interswitch switching network",
        matchingConfig: JSON.stringify({ amountTolerance: 0, dateWindowDays: 2, primaryRef: "rrn", secondaryRef: "stan" }),
        fileFormat: JSON.stringify({ columns: ["rrn", "stan", "terminalId", "merchantId", "amount", "cardType", "transactionDate", "responseCode"] }),
      },
      {
        name: "Card Payments (Visa/Mastercard)",
        code: "CARD_PAYMENTS",
        channelType: "card_payments",
        description: "International card scheme transactions — Visa and Mastercard settlement files",
        matchingConfig: JSON.stringify({ amountTolerance: 0.005, dateWindowDays: 3, primaryRef: "rrn", secondaryRef: "authCode" }),
        fileFormat: JSON.stringify({ columns: ["rrn", "authCode", "cardScheme", "maskedPan", "amount", "currency", "merchantName", "transactionDate"] }),
      },
      {
        name: "USSD Transactions",
        code: "USSD_CHANNEL",
        channelType: "ussd",
        description: "USSD-initiated mobile banking transactions (*737#, *770#, *901# etc.)",
        matchingConfig: JSON.stringify({ amountTolerance: 0, dateWindowDays: 1, primaryRef: "sessionId", secondaryRef: "msisdn" }),
        fileFormat: JSON.stringify({ columns: ["sessionId", "msisdn", "amount", "beneficiaryAccount", "beneficiaryBank", "narration", "transactionDate", "status"] }),
      },
      {
        name: "Agent Banking (Moniepoint)",
        code: "AGENT_MONIEPOINT",
        channelType: "agent_banking",
        description: "Agent banking transactions via Moniepoint network — cash-in, cash-out, transfers",
        matchingConfig: JSON.stringify({ amountTolerance: 0, dateWindowDays: 2, primaryRef: "transactionRef", secondaryRef: "agentTerminalId" }),
        fileFormat: JSON.stringify({ columns: ["transactionRef", "agentTerminalId", "agentName", "transactionType", "amount", "customerAccount", "transactionDate", "status"] }),
      },
      {
        name: "Mobile Money (OPay)",
        code: "MOBILE_MONEY_OPAY",
        channelType: "mobile_money",
        description: "OPay mobile money transactions — wallet transfers, bill payments, cash-out",
        matchingConfig: JSON.stringify({ amountTolerance: 0, dateWindowDays: 1, primaryRef: "transactionId", secondaryRef: "walletId" }),
        fileFormat: JSON.stringify({ columns: ["transactionId", "walletId", "msisdn", "transactionType", "amount", "counterparty", "transactionDate", "status"] }),
      },
      {
        name: "Mobile Banking (GTBank App)",
        code: "MOBILE_BANKING_GTB",
        channelType: "mobile_banking",
        description: "GTBank mobile banking app transactions — transfers, bill payments, airtime",
        matchingConfig: JSON.stringify({ amountTolerance: 0, dateWindowDays: 1, primaryRef: "transactionRef", secondaryRef: "deviceId" }),
        fileFormat: JSON.stringify({ columns: ["transactionRef", "deviceId", "amount", "transactionType", "beneficiaryAccount", "beneficiaryBank", "narration", "transactionDate"] }),
      },
      {
        name: "Bank Core / GL (CBS)",
        code: "BANK_CORE_GL",
        channelType: "bank_core",
        description: "Core Banking System General Ledger entries — the authoritative source of truth",
        matchingConfig: JSON.stringify({ amountTolerance: 0.001, dateWindowDays: 3, primaryRef: "glRef", secondaryRef: "transactionRef" }),
        fileFormat: JSON.stringify({ columns: ["glRef", "transactionRef", "glAccount", "debitCredit", "amount", "narration", "valueDate", "postingDate"] }),
      },
    ];

    const channelIds = {};
    for (const ch of channelDefs) {
      const [existing] = await conn.execute("SELECT id FROM channels WHERE code = ?", [ch.code]);
      if (existing.length === 0) {
        const [res] = await conn.execute(
          `INSERT INTO channels (organizationId, name, code, description, channelType, matchingConfig, fileFormat, isActive, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
          [orgId, ch.name, ch.code, ch.description, ch.channelType, ch.matchingConfig, ch.fileFormat]
        );
        channelIds[ch.code] = res.insertId;
        console.log(`  ✅ Created channel: ${ch.name} (id=${res.insertId})`);
      } else {
        channelIds[ch.code] = existing[0].id;
        console.log(`  ℹ️  Channel exists: ${ch.name} (id=${existing[0].id})`);
      }
    }

    // ── 4. Seed transactions per channel ────────────────────────────────────
    const dateStart = new Date("2026-03-01T00:00:00Z");
    const dateEnd   = new Date("2026-04-10T23:59:59Z");

    // Channel-specific transaction generators
    const channelGenerators = {
      NIBSS_NIP: (i) => {
        const senderBank = randFrom(NIGERIAN_BANKS);
        const receiverBank = randFrom(NIGERIAN_BANKS);
        const amt = randomAmount(5000, 5000000);
        const sessionId = nipSessionId();
        const rrnVal = rrn();
        return {
          transactionRef: sessionId,
          externalRef: rrnVal,
          description: `NIP Transfer from ${senderBank.shortName} to ${receiverBank.shortName} | ${randFrom(["Salary Payment", "Vendor Payment", "Customer Refund", "Invoice Settlement", "Loan Disbursement"])}`,
          amount: amt,
          debitCredit: i % 3 === 0 ? "debit" : "credit",
          counterparty: `${senderBank.name} → ${receiverBank.name}`,
          rawData: JSON.stringify({ nipSessionId: sessionId, rrn: rrnVal, senderBank: senderBank.code, receiverBank: receiverBank.code, senderAccount: accountNumber(), receiverAccount: accountNumber(), narration: "NIP Transfer" }),
        };
      },
      POS_INTERSWITCH: (i) => {
        const rrnVal = rrn();
        const stanVal = stan();
        const termId = terminalId();
        const merId = merchantId();
        const amt = randomAmount(500, 500000);
        return {
          transactionRef: rrnVal,
          externalRef: stanVal,
          description: `POS Purchase | Terminal: ${termId} | ${randFrom(["Supermarket", "Fuel Station", "Restaurant", "Pharmacy", "Electronics Store"])}`,
          amount: amt,
          debitCredit: "debit",
          counterparty: `Terminal ${termId}`,
          rawData: JSON.stringify({ rrn: rrnVal, stan: stanVal, terminalId: termId, merchantId: merId, cardType: randFrom(["VISA", "MASTERCARD", "VERVE"]), responseCode: "00" }),
        };
      },
      CARD_PAYMENTS: (i) => {
        const rrnVal = rrn();
        const authCode = String(randInt(100000, 999999));
        const amt = randomAmount(1000, 2000000);
        const scheme = randFrom(["VISA", "MASTERCARD"]);
        return {
          transactionRef: rrnVal,
          externalRef: authCode,
          description: `${scheme} Card Payment | Auth: ${authCode} | ${randFrom(["Online Purchase", "Recurring Subscription", "International Transfer", "E-commerce", "Hotel Booking"])}`,
          amount: amt,
          debitCredit: i % 4 === 0 ? "credit" : "debit",
          counterparty: `${scheme} Network`,
          rawData: JSON.stringify({ rrn: rrnVal, authCode, cardScheme: scheme, maskedPan: `****${randInt(1000,9999)}`, currency: "NGN" }),
        };
      },
      USSD_CHANNEL: (i) => {
        const sessionId = `USSD${nipSessionId()}`;
        const msisdn = `0${randFrom(["803","806","813","816","703","706","803","810","813"])}${randInt(1000000,9999999)}`;
        const amt = randomAmount(500, 200000);
        const benefBank = randFrom(NIGERIAN_BANKS);
        return {
          transactionRef: sessionId,
          externalRef: msisdn,
          description: `USSD Transfer | ${msisdn} → ${benefBank.shortName} | ${randFrom(["*737#", "*770#", "*901#", "*822#"])}`,
          amount: amt,
          debitCredit: "debit",
          counterparty: `${msisdn} via ${benefBank.name}`,
          rawData: JSON.stringify({ sessionId, msisdn, beneficiaryBank: benefBank.code, beneficiaryAccount: accountNumber(), ussdCode: randFrom(["*737#", "*770#", "*901#"]) }),
        };
      },
      AGENT_MONIEPOINT: (i) => {
        const txRef = `MNP${nipSessionId()}`;
        const agentTermId = `AGT${randInt(10000,99999)}`;
        const amt = randomAmount(500, 100000);
        const txType = randFrom(["CASH_IN", "CASH_OUT", "TRANSFER", "AIRTIME", "BILL_PAYMENT"]);
        return {
          transactionRef: txRef,
          externalRef: agentTermId,
          description: `Agent Banking | ${txType} | Terminal: ${agentTermId} | ${randFrom(NIGERIAN_STATES)} State`,
          amount: amt,
          debitCredit: txType === "CASH_IN" ? "credit" : "debit",
          counterparty: `Moniepoint Agent ${agentTermId}`,
          rawData: JSON.stringify({ transactionRef: txRef, agentTerminalId: agentTermId, transactionType: txType, agentName: `Agent ${randInt(1000,9999)}`, customerAccount: accountNumber() }),
        };
      },
      MOBILE_MONEY_OPAY: (i) => {
        const txId = `OPY${nipSessionId()}`;
        const walletId = `WLT${randInt(1000000,9999999)}`;
        const msisdn = `0${randFrom(["803","806","813","816","703","706"])}${randInt(1000000,9999999)}`;
        const amt = randomAmount(200, 500000);
        const txType = randFrom(["WALLET_TRANSFER", "BANK_TRANSFER", "CASH_OUT", "BILL_PAYMENT", "AIRTIME"]);
        return {
          transactionRef: txId,
          externalRef: walletId,
          description: `OPay Mobile Money | ${txType} | Wallet: ${walletId}`,
          amount: amt,
          debitCredit: i % 3 === 0 ? "credit" : "debit",
          counterparty: `OPay Wallet ${walletId}`,
          rawData: JSON.stringify({ transactionId: txId, walletId, msisdn, transactionType: txType }),
        };
      },
      MOBILE_BANKING_GTB: (i) => {
        const txRef = `GTB${nipSessionId()}`;
        const deviceId = `DEV${randInt(100000,999999)}`;
        const amt = randomAmount(1000, 10000000);
        const txType = randFrom(["TRANSFER", "BILL_PAYMENT", "AIRTIME", "SAVINGS", "INVESTMENT"]);
        const benefBank = randFrom(NIGERIAN_BANKS);
        return {
          transactionRef: txRef,
          externalRef: deviceId,
          description: `GTBank Mobile | ${txType} → ${benefBank.shortName} | ${randFrom(["GTWorld App", "GTBank Mobile App"])}`,
          amount: amt,
          debitCredit: i % 4 === 0 ? "credit" : "debit",
          counterparty: `${benefBank.name} via GTBank Mobile`,
          rawData: JSON.stringify({ transactionRef: txRef, deviceId, transactionType: txType, beneficiaryBank: benefBank.code, beneficiaryAccount: accountNumber() }),
        };
      },
      BANK_CORE_GL: (i) => {
        const glRef = `GL${new Date().getFullYear()}${String(randInt(100000,999999))}`;
        const txRef = `TXN${nipSessionId()}`;
        const glAccounts = ["1001-NOSTRO", "1002-SETTLEMENT", "2001-CUSTOMER-LIAB", "3001-INCOME", "4001-EXPENSE", "5001-SUSPENSE"];
        const amt = randomAmount(5000, 50000000);
        return {
          transactionRef: glRef,
          externalRef: txRef,
          description: `CBS GL Entry | ${randFrom(glAccounts)} | ${randFrom(["Daily Settlement", "Interest Accrual", "Fee Income", "Charge-off", "Reversal Entry", "Month-end Adjustment"])}`,
          amount: amt,
          debitCredit: i % 2 === 0 ? "debit" : "credit",
          counterparty: `GL Account ${randFrom(glAccounts)}`,
          rawData: JSON.stringify({ glRef, transactionRef: txRef, glAccount: randFrom(glAccounts), postingDate: new Date().toISOString() }),
        };
      },
    };

    // Transaction counts per channel (realistic volumes)
    const channelVolumes = {
      NIBSS_NIP:          200,
      POS_INTERSWITCH:    180,
      CARD_PAYMENTS:      150,
      USSD_CHANNEL:       160,
      AGENT_MONIEPOINT:   140,
      MOBILE_MONEY_OPAY:  130,
      MOBILE_BANKING_GTB: 120,
      BANK_CORE_GL:       100,
    };

    // Store inserted transaction IDs for matching
    const channelTxnIds = {};

    for (const [channelCode, count] of Object.entries(channelVolumes)) {
      const channelId = channelIds[channelCode];
      if (!channelId) continue;

      console.log(`\n📊 Seeding channel: ${channelCode} (${count} transactions)`);

      // Create upload batch for this channel
      const batchFileName = `demo_${channelCode.toLowerCase()}_${Date.now()}.csv`;
      const [batchRes] = await conn.execute(
        `INSERT INTO upload_batches (userId, channelId, organizationId, fileName, fileHash, totalRows, validRows, invalidRows, status, createdAt, completedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'completed', NOW(), NOW())`,
        [adminUserId, channelId, orgId, batchFileName, crypto.randomBytes(32).toString("hex"), count, count]
      );
      const batchId = batchRes.insertId;

      const generator = channelGenerators[channelCode];
      const txnIds = [];

      // Insert transactions in batches of 50
      const BATCH = 50;
      for (let start = 0; start < count; start += BATCH) {
        const end = Math.min(start + BATCH, count);
        const values = [];
        const placeholders = [];

        for (let i = start; i < end; i++) {
          const txDate = randomDate(dateStart, dateEnd);
          const valueDate = new Date(txDate.getTime() + randInt(0, 2) * 86400000);
          const gen = generator(i);

          // 90–95% will be matched, 5–10% exception/unmatched
          const rand = Math.random();
          let status;
          if (rand < 0.92) status = "matched";
          else if (rand < 0.96) status = "exception";
          else status = "unmatched";

          values.push(
            batchId, channelId, adminUserId, orgId,
            gen.transactionRef, gen.externalRef, gen.description,
            gen.amount, "NGN", txDate, valueDate,
            gen.debitCredit, gen.counterparty,
            0, null, status, null,
            gen.rawData
          );
          placeholders.push("(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
        }

        const [insertRes] = await conn.execute(
          `INSERT INTO transactions (batchId, channelId, userId, organizationId, transactionRef, externalRef, description, amount, currency, transactionDate, valueDate, debitCredit, counterparty, isReversal, originalTransactionRef, status, matchId, rawData)
           VALUES ${placeholders.join(",")}`,
          values
        );

        // Collect IDs
        const firstId = insertRes.insertId;
        for (let j = 0; j < (end - start); j++) {
          txnIds.push(firstId + j);
        }
      }

      channelTxnIds[channelCode] = txnIds;
      console.log(`  ✅ Inserted ${count} transactions for ${channelCode}`);
    }

    // ── 5. Create reconciliation jobs and matches ────────────────────────────
    // Pair each channel against the CBS GL as the authoritative source
    const glChannelId = channelIds["BANK_CORE_GL"];
    const pairings = [
      ["NIBSS_NIP", "BANK_CORE_GL"],
      ["POS_INTERSWITCH", "BANK_CORE_GL"],
      ["CARD_PAYMENTS", "BANK_CORE_GL"],
      ["USSD_CHANNEL", "BANK_CORE_GL"],
      ["AGENT_MONIEPOINT", "BANK_CORE_GL"],
      ["MOBILE_MONEY_OPAY", "BANK_CORE_GL"],
      ["MOBILE_BANKING_GTB", "BANK_CORE_GL"],
    ];

    for (const [srcCode, tgtCode] of pairings) {
      const srcId = channelIds[srcCode];
      const tgtId = channelIds[tgtCode];
      if (!srcId || !tgtId) continue;

      const srcTxns = channelTxnIds[srcCode] || [];
      const tgtTxns = channelTxnIds[tgtCode] || [];

      const matchedSrc = srcTxns.filter((_, i) => {
        // Simulate 92% match rate
        return i % 100 < 92;
      });

      const matchCount = Math.min(matchedSrc.length, tgtTxns.length);
      const exceptionCount = Math.round(srcTxns.length * 0.04);
      const unmatchedCount = srcTxns.length - matchCount - exceptionCount;
      const matchRate = ((matchCount / srcTxns.length) * 100).toFixed(2);

      // Create reconciliation job
      const [jobRes] = await conn.execute(
        `INSERT INTO reconciliation_jobs
           (userId, organizationId, moduleType, name, sourceChannelId, targetChannelId,
            dateFrom, dateTo, amountTolerance, dateWindowDays, status,
            totalSourceTxns, totalTargetTxns, matchedCount, exceptionCount, unmatchedCount,
            matchRate, processingTimeMs, startedAt, completedAt, createdAt)
         VALUES (?, ?, 'transaction_integrity', ?, ?, ?, ?, ?, 0.005, 3, 'completed',
                 ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
        [
          adminUserId, orgId,
          `${srcCode} vs CBS GL — April 2026`,
          srcId, tgtId,
          dateStart, dateEnd,
          srcTxns.length, tgtTxns.length,
          matchCount, exceptionCount, unmatchedCount,
          matchRate,
          randInt(1200, 8500),
        ]
      );
      const jobId = jobRes.insertId;

      // Insert match records (batch)
      const matchTypes = ["exact", "exact", "exact", "fuzzy", "amount_tolerance", "date_window"];
      const MBATCH = 50;
      for (let i = 0; i < matchCount; i += MBATCH) {
        const end = Math.min(i + MBATCH, matchCount);
        const vals = [];
        const ph = [];
        for (let j = i; j < end; j++) {
          const srcTxnId = matchedSrc[j];
          const tgtTxnId = tgtTxns[j % tgtTxns.length];
          const mType = randFrom(matchTypes);
          const confidence = mType === "exact" ? "100.00" : (85 + Math.random() * 14).toFixed(2);
          const amtDiff = mType === "exact" ? "0.00" : (Math.random() * 50).toFixed(2);
          const dateDiff = mType === "date_window" ? randInt(1, 3) : 0;
          vals.push(jobId, srcTxnId, tgtTxnId, mType, confidence, amtDiff, dateDiff,
            `${mType === "exact" ? "Exact reference match" : "Fuzzy match on amount + date window"} — ${srcCode}`,
            "confirmed");
          ph.push("(?,?,?,?,?,?,?,?,?)");
        }
        await conn.execute(
          `INSERT INTO matches (jobId, sourceTransactionId, targetTransactionId, matchType, confidenceScore, amountDifference, dateDifference, matchReason, status)
           VALUES ${ph.join(",")}`,
          vals
        );
      }

      // Create a few exceptions for the unmatched ones
      const exceptionTypes = [
        ["amount_mismatch", "Amount in source differs from CBS GL by more than tolerance threshold"],
        ["missing_counterparty", "Counterparty account not found in CBS customer master"],
        ["timing_difference", "Transaction date in source falls outside 3-day settlement window"],
        ["duplicate_transaction", "Duplicate reference detected — possible double-posting"],
        ["format_error", "Reference format does not match expected NIP session ID pattern"],
      ];

      const exceptionTxns = srcTxns.slice(matchCount, matchCount + exceptionCount);
      for (let i = 0; i < exceptionTxns.length; i++) {
        const [etype, edesc] = randFrom(exceptionTypes);
        const severity = randFrom(["low", "medium", "high"]);
        await conn.execute(
          `INSERT INTO exceptions (jobId, transactionId, category, severity, description, suggestedResolution, status, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, 'open', NOW())`,
          [
            jobId, exceptionTxns[i], etype, severity, edesc,
            `Review ${etype.replace(/_/g," ")} and verify against CBS GL entry`,
          ]
        );
      }

      console.log(`  ✅ Job created: ${srcCode} vs CBS GL | Match rate: ${matchRate}% | Matches: ${matchCount} | Exceptions: ${exceptionCount}`);
    }

    // ── 6. Seed Distributor Identity Registry ────────────────────────────────
    console.log("\n📋 Seeding Distributor Identity Registry...");

    const [existingDist] = await conn.execute(
      "SELECT COUNT(*) as cnt FROM distributors WHERE organizationId = ?", [orgId]
    );
    if (existingDist[0].cnt > 0) {
      console.log(`  ℹ️  Distributors already seeded (${existingDist[0].cnt} records). Skipping.`);
    } else {
      for (let i = 0; i < DISTRIBUTOR_NAMES.length; i++) {
        const dist = DISTRIBUTOR_NAMES[i];
        const canonicalId = `DIST-${String(i + 1).padStart(4, "0")}`;
        const bank = randFrom(NIGERIAN_BANKS);
        const state = randFrom(NIGERIAN_STATES);
        const zone = randFrom(ZONES);
        const status = i < 25 ? "active" : (i < 28 ? "pending_confirmation" : "flagged");
        const totalMatched = randInt(50, 2000);
        const totalAmount = (Math.random() * 500000000 + 1000000).toFixed(2);
        const lastPayment = randomDate(new Date("2026-02-01"), new Date("2026-04-10"));

        await conn.execute(
          `INSERT INTO distributors
             (organizationId, canonicalId, canonicalName, registeredBusinessName, taxId,
              primaryBankAccount, primaryBankName, contactEmail, contactPhone, zone, status,
              nameVariants, totalPaymentsMatched, totalAmountMatched, lastPaymentAt,
              confirmedBy, confirmedAt, notes, createdBy, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            orgId,
            canonicalId,
            dist.canonical,
            dist.canonical + (i % 3 === 0 ? " Limited" : " Nig. Ltd"),
            `TIN${String(randInt(10000000000, 99999999999))}`,
            nuban(bank.code),
            bank.name,
            `info@${dist.canonical.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 15)}.ng`,
            `0${randFrom(["803","806","813","816","703","706","803","810"])}${randInt(1000000,9999999)}`,
            zone,
            status,
            JSON.stringify(dist.variants),
            totalMatched,
            totalAmount,
            lastPayment,
            status === "active" ? adminUserId : null,
            status === "active" ? new Date() : null,
            i >= 28 ? "Flagged: inconsistent payment references across 3 cycles. Pending investigation." : null,
            adminUserId,
          ]
        );
      }
      console.log(`  ✅ Seeded ${DISTRIBUTOR_NAMES.length} distributors`);
    }

    // ── 7. Seed a multi-channel reconciliation report ────────────────────────
    console.log("\n📈 Creating multi-channel reconciliation report...");

    // reconciliation_reports requires a jobId — use the first job created
    const [existingReport] = await conn.execute(
      "SELECT id FROM reconciliation_reports WHERE organizationId = ? LIMIT 1",
      [orgId]
    );

    if (existingReport.length === 0) {
      const totalTxns = Object.values(channelVolumes).reduce((a, b) => a + b, 0);
      const totalMatched = Math.round(totalTxns * 0.92);
      const totalExceptions = Math.round(totalTxns * 0.04);
      const totalUnmatched = totalTxns - totalMatched - totalExceptions;

      // Get first job id
      const [firstJob] = await conn.execute(
        "SELECT id FROM reconciliation_jobs WHERE organizationId = ? ORDER BY id ASC LIMIT 1",
        [orgId]
      );
      if (firstJob.length > 0) {
        await conn.execute(
          `INSERT INTO reconciliation_reports
             (jobId, userId, organizationId, reportType, title, summary, format, createdAt)
           VALUES (?, ?, ?, 'custom', ?, ?, 'pdf', NOW())`,
          [
            firstJob[0].id, adminUserId, orgId,
            "Multi-Channel Reconciliation Report — April 2026",
            JSON.stringify({
              totalTransactions: totalTxns,
              matchedTransactions: totalMatched,
              exceptionCount: totalExceptions,
              unmatchedCount: totalUnmatched,
              overallMatchRate: ((totalMatched / totalTxns) * 100).toFixed(2),
              channels: Object.entries(channelVolumes).map(([code, vol]) => ({
                channel: code,
                channelId: channelIds[code],
                totalTransactions: vol,
                matchedTransactions: Math.round(vol * 0.92),
                matchRate: (92 + Math.random() * 3).toFixed(2),
              }))
            }),
          ]
        );
        console.log(`  ✅ Created multi-channel report: ${totalTxns} total txns, ${totalMatched} matched (${((totalMatched/totalTxns)*100).toFixed(1)}%)`);
      }
    } else {
      console.log("  ℹ️  Report already exists.");
    }

    console.log("\n🎉 Seed complete! Summary:");
    console.log(`   Organization: Globus Bank Nigeria (Demo) — id=${orgId}`);
    console.log(`   Channels seeded: ${Object.keys(channelIds).length}`);
    const totalTxns = Object.values(channelVolumes).reduce((a, b) => a + b, 0);
    console.log(`   Transactions seeded: ${totalTxns}`);
    console.log(`   Distributors seeded: ${DISTRIBUTOR_NAMES.length}`);
    console.log(`   Reconciliation jobs: ${pairings.length}`);
    console.log(`   Target match rate: 90–95% per channel`);

  } catch (err) {
    console.error("❌ Seed error:", err);
    throw err;
  } finally {
    await conn.end();
  }
}

seed().catch((e) => { console.error(e); process.exit(1); });
