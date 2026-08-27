/**
 * Demo Seed Engine — ReconcileAI
 * Two demo modes:
 *   1. FMCG — BrightGoods Nigeria Ltd (1,000 transactions, 95% match rate)
 *   2. Financial Services — LapoMFB + Renmoney MFB (1,000,000 transactions, 95% match rate, all payment rails)
 *
 * All demo records are tagged with isDemoData: true so they can be cleanly wiped.
 */

import { getDb } from "./db";
import { featureStrictlyAppliesTo } from "@shared/verticalFeatures";
import {
  transactions,
  uploadBatches,
  reconciliationJobs,
  matches,
  exceptions,
  distributors,
  agentMemory,
  channels,
  organizations,
} from "../drizzle/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

// ─── Shared Utilities ────────────────────────────────────────────────

function demoTag(extra?: Record<string, unknown>) {
  return { isDemoData: true, seededAt: new Date().toISOString(), ...extra };
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(9, 0, 0, 0);
  return d;
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomAmount(minK: number, maxK: number): string {
  return (randomBetween(minK, maxK) * 1000).toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────
// SECTION 1: FMCG DEMO — BrightGoods Nigeria Ltd
// ─────────────────────────────────────────────────────────────────────

const FMCG_DISTRIBUTORS = [
  { canonicalName: "Kola Ventures Ltd", registeredBusinessName: "Kola Ventures & Sons Nigeria Limited", taxId: "RC-0284761", primaryBankName: "GTBank", primaryBankAccount: "0123456789", contactPhone: "+234-803-456-7890", zone: "Lagos", nameVariants: ["Kola Ventures", "Kolade Ventures & Sons", "KV Nigeria Ltd", "KOLA VENTURES LTD"] },
  { canonicalName: "Sunrise Distribution Co.", registeredBusinessName: "Sunrise Distribution Company Nigeria Ltd", taxId: "RC-0391842", primaryBankName: "Access Bank", primaryBankAccount: "0987654321", contactPhone: "+234-805-678-9012", zone: "Abuja", nameVariants: ["Sunrise Dist Co", "Sunrise Distribution", "SUNRISE DIST CO NIG"] },
  { canonicalName: "Eko Traders International", registeredBusinessName: "Eko Traders International Nigeria Ltd", taxId: "RC-0472938", primaryBankName: "First Bank", primaryBankAccount: "2034567890", contactPhone: "+234-802-345-6789", zone: "Lagos", nameVariants: ["Eko Traders", "ETI Nigeria", "Eko Traders Intl"] },
  { canonicalName: "Northern Supplies Ltd", registeredBusinessName: "Northern Supplies Limited", taxId: "RC-0583047", primaryBankName: "Zenith Bank", primaryBankAccount: "1234567890", contactPhone: "+234-806-789-0123", zone: "Kano", nameVariants: ["Northern Supplies", "NS Ltd", "NORTHERN SUPPLIES NIG"] },
  { canonicalName: "Chukwu & Associates Trading", registeredBusinessName: "Chukwu and Associates Trading Company Ltd", taxId: "RC-0694156", primaryBankName: "UBA", primaryBankAccount: "3045678901", contactPhone: "+234-807-890-1234", zone: "Onitsha", nameVariants: ["Chukwu Associates", "C&A Trading", "Chukwu & Assoc"] },
  { canonicalName: "Ibadan Wholesale Merchants", registeredBusinessName: "Ibadan Wholesale Merchants Nigeria Ltd", taxId: "RC-0705263", primaryBankName: "Stanbic IBTC", primaryBankAccount: "4056789012", contactPhone: "+234-808-901-2345", zone: "Ibadan", nameVariants: ["IWM Nigeria", "Ibadan Wholesale", "IBADAN WHLSL MERCH"] },
  { canonicalName: "Delta Distributors Ltd", registeredBusinessName: "Delta Distributors Limited", taxId: "RC-0816374", primaryBankName: "Fidelity Bank", primaryBankAccount: "5067890123", contactPhone: "+234-809-012-3456", zone: "Warri", nameVariants: ["Delta Dist", "DDL Nigeria", "Delta Distributors"] },
  { canonicalName: "Abuja Metro Supplies", registeredBusinessName: "Abuja Metropolitan Supplies Ltd", taxId: "RC-0927485", primaryBankName: "FCMB", primaryBankAccount: "6078901234", contactPhone: "+234-810-123-4567", zone: "Abuja", nameVariants: ["Abuja Metro", "AMS Ltd", "Abuja Metropolitan Supplies"] },
  { canonicalName: "Port Harcourt Mega Distributors", registeredBusinessName: "Port Harcourt Mega Distributors Nigeria Ltd", taxId: "RC-1038596", primaryBankName: "GTBank", primaryBankAccount: "7089012345", contactPhone: "+234-811-234-5678", zone: "Port Harcourt", nameVariants: ["PH Mega Dist", "Port Harcourt Mega", "PHMDN Ltd"] },
  { canonicalName: "Enugu Central Supplies", registeredBusinessName: "Enugu Central Supplies & Trading Ltd", taxId: "RC-1149607", primaryBankName: "Access Bank", primaryBankAccount: "8090123456", contactPhone: "+234-812-345-6789", zone: "Enugu", nameVariants: ["Enugu Central", "ECS Trading", "Enugu Central Supplies & Trading"] },
  { canonicalName: "Kaduna Allied Merchants", registeredBusinessName: "Kaduna Allied Merchants Company Ltd", taxId: "RC-1250718", primaryBankName: "Zenith Bank", primaryBankAccount: "9001234567", contactPhone: "+234-813-456-7890", zone: "Kaduna", nameVariants: ["Kaduna Allied", "KAM Company", "KADUNA ALLIED MERCH"] },
  { canonicalName: "Benin City Wholesale Hub", registeredBusinessName: "Benin City Wholesale Hub Nigeria Ltd", taxId: "RC-1361829", primaryBankName: "UBA", primaryBankAccount: "0112345678", contactPhone: "+234-814-567-8901", zone: "Benin City", nameVariants: ["Benin Wholesale", "BCWH Nigeria", "Benin City Wholesale"] },
  { canonicalName: "Maiduguri Trade Partners", registeredBusinessName: "Maiduguri Trade Partners Ltd", taxId: "RC-1472930", primaryBankName: "First Bank", primaryBankAccount: "1123456789", contactPhone: "+234-815-678-9012", zone: "Maiduguri", nameVariants: ["Maiduguri Trade", "MTP Ltd", "MAIDUGURI TRADE PARTNERS"] },
  { canonicalName: "Calabar Coastal Distributors", registeredBusinessName: "Calabar Coastal Distributors Nigeria Ltd", taxId: "RC-1583041", primaryBankName: "Stanbic IBTC", primaryBankAccount: "2134567890", contactPhone: "+234-816-789-0123", zone: "Calabar", nameVariants: ["Calabar Coastal", "CCD Nigeria", "Calabar Dist"] },
  { canonicalName: "Sokoto Frontier Traders", registeredBusinessName: "Sokoto Frontier Traders Nigeria Ltd", taxId: "RC-1694152", primaryBankName: "Jaiz Bank", primaryBankAccount: "3145678901", contactPhone: "+234-817-890-1234", zone: "Sokoto", nameVariants: ["Sokoto Frontier", "SFT Nigeria", "SOKOTO FRONTIER"] },
];

// 50 exception scenarios for FMCG (5% of 1,000 transactions)
const FMCG_EXCEPTION_SCENARIOS = [
  { category: "amount_mismatch" as const, severity: "high" as const, srcAmount: "1800000.00", tgtAmount: "2400000.00", srcDesc: "Payment Kola Ventures INV-2854 partial", tgtDesc: "Order INV-2854 Kola Ventures Ltd Lagos Zone", srcRef: "BANK-INV-2854", tgtRef: "INV-2854", cp: "Kola Ventures Ltd", aiAnalysis: "PARTIAL PAYMENT DETECTED. Kola Ventures paid ₦1,800,000 against a ₦2,400,000 invoice (INV-2854). The ₦600,000 shortfall (25%) is consistent with a promotional deduction claimed on this order. Historical pattern: Kola Ventures has claimed promotional deductions on 3 of the last 8 invoices. Recommended action: Request a promotional deduction credit note from the distributor.", suggestedResolution: "Request credit note for ₦600,000 promotional deduction from Kola Ventures Ltd. Reference: INV-2854." },
  { category: "amount_mismatch" as const, severity: "low" as const, srcAmount: "2398500.00", tgtAmount: "2400000.00", srcDesc: "Payment Sunrise Distribution INV-2855", tgtDesc: "Order INV-2855 Sunrise Distribution Co. Abuja Zone", srcRef: "BANK-INV-2855", tgtRef: "INV-2855", cp: "Sunrise Distribution Co.", aiAnalysis: "FX BANK FEE DEDUCTION. The ₦1,500 shortfall (0.0625%) is consistent with a standard GTBank inter-bank transfer fee. This is a valid match — the variance is below the 0.5% tolerance threshold. No action required from the distributor.", suggestedResolution: "Auto-approve match. Post ₦1,500 bank charge to Bank Charges GL account. Reference: INV-2855." },
  { category: "amount_mismatch" as const, severity: "high" as const, srcAmount: "1650000.00", tgtAmount: "1980000.00", srcDesc: "Payment Eko Traders INV-2847 less dmg", tgtDesc: "Order INV-2847 Eko Traders International Lagos Zone", srcRef: "BANK-INV-2847-DMG", tgtRef: "INV-2847", cp: "Eko Traders International", aiAnalysis: "DAMAGE DEDUCTION CLAIM DETECTED. The payment reference 'INV-2847 less dmg' contains a damage claim keyword. Eko Traders is claiming a ₦330,000 (16.7%) deduction for damaged goods on delivery. This requires physical verification before approval. Recommended action: Request damage assessment report from the logistics team.", suggestedResolution: "Escalate to logistics team for damage verification. If confirmed, issue credit note for ₦330,000. Reference: INV-2847." },
  { category: "amount_mismatch" as const, severity: "medium" as const, srcAmount: "10000000.00", tgtAmount: "3300000.00", srcDesc: "Bulk payment Northern Supplies INV-2860 INV-2861 INV-2862", tgtDesc: "Order INV-2860 Northern Supplies Ltd Kano Zone", srcRef: "BANK-BULK-001", tgtRef: "INV-2860", cp: "Northern Supplies Ltd", aiAnalysis: "MANY-TO-MANY MATCH DETECTED. Northern Supplies Ltd sent a single ₦10M bulk payment covering three outstanding invoices: INV-2860 (₦3,300,000), INV-2861 (₦3,300,000), INV-2862 (₦3,400,000). Total: ₦10,000,000 — exact match. Split allocation: 33%/33%/34%. Confidence: 98%. Recommended action: Approve the split allocation and post to three separate GL entries.", suggestedResolution: "Approve many-to-many split: allocate ₦3.3M to INV-2860, ₦3.3M to INV-2861, ₦3.4M to INV-2862." },
  { category: "timing_difference" as const, severity: "low" as const, srcAmount: "4750000.00", tgtAmount: "4750000.00", srcDesc: "Late payment Chukwu Associates INV-2863", tgtDesc: "Order INV-2863 Chukwu and Associates Trading Company Ltd Onitsha Zone", srcRef: "BANK-INV-2863", tgtRef: "INV-2863", cp: "Chukwu & Associates Trading", aiAnalysis: "TIMING DIFFERENCE — WITHIN TOLERANCE. Payment received 4 days after invoice date, which exceeds the standard 3-day window. However, the amount matches exactly (₦4,750,000) and the distributor name matches the canonical record. This is a late payment, not a mismatch. Recommended action: Auto-approve with a late payment flag.", suggestedResolution: "Auto-approve match with late payment flag. Issue a late payment notice to Chukwu & Associates Trading." },
  { category: "missing_counterparty" as const, severity: "medium" as const, srcAmount: "2100000.00", tgtAmount: "2100000.00", srcDesc: "NEFT CR 0123456789 IBADAN WHLSL MERCH", tgtDesc: "Order INV-2865 Ibadan Wholesale Merchants Nigeria Ltd Ibadan Zone", srcRef: "BANK-UNK-001", tgtRef: "INV-2865", cp: "IBADAN WHLSL MERCH", aiAnalysis: "COUNTERPARTY IDENTITY RESOLUTION REQUIRED. The bank statement shows 'IBADAN WHLSL MERCH' — an abbreviated form not yet registered in the Master Distributor File. Fuzzy match confidence: 87% — likely 'Ibadan Wholesale Merchants Nigeria Ltd'. Amount (₦2,100,000) matches INV-2865 exactly. Recommended action: Confirm identity in the Distributor Registry and add the abbreviation as a known alias.", suggestedResolution: "Confirm 'IBADAN WHLSL MERCH' = 'Ibadan Wholesale Merchants Nigeria Ltd' in Distributor Registry. Add alias. Then approve match to INV-2865." },
];

// Generate additional exception scenarios to reach 50 total
function generateFmcgExceptions(startIdx: number, count: number) {
  const templates = [
    { category: "amount_mismatch" as const, severity: "medium" as const, shortfallPct: 0.1, reason: "promotional deduction", aiSuffix: "Distributor claimed a 10% promotional allowance for the quarter. Verify against approved promotional budget before approving.", resSuffix: "Verify promotional allowance against approved budget. Issue credit note if confirmed." },
    { category: "timing_difference" as const, severity: "low" as const, shortfallPct: 0, reason: "late payment", aiSuffix: "Payment received 5 days after invoice date. Amount matches exactly. Late payment notice recommended.", resSuffix: "Auto-approve with late payment flag. Issue late payment notice." },
    { category: "amount_mismatch" as const, severity: "low" as const, shortfallPct: 0.0005, reason: "bank fee", aiSuffix: "Variance of 0.05% is consistent with standard inter-bank transfer fee. Below tolerance threshold. Auto-approve recommended.", resSuffix: "Auto-approve. Post variance to Bank Charges GL." },
    { category: "missing_counterparty" as const, severity: "medium" as const, shortfallPct: 0, reason: "name abbreviation", aiSuffix: "Bank statement shows abbreviated counterparty name. Fuzzy match confidence 85%. Confirm identity in Distributor Registry.", resSuffix: "Confirm identity in Distributor Registry. Add alias to prevent recurrence." },
    { category: "duplicate_transaction" as const, severity: "high" as const, shortfallPct: 0, reason: "duplicate payment", aiSuffix: "Same reference number and amount appear twice within 24 hours. Likely a double-submission by the distributor. Reverse the second payment.", resSuffix: "Reverse duplicate payment. Notify distributor. Confirm original payment as settled." },
  ];
  const dist = FMCG_DISTRIBUTORS;
  const result = [];
  for (let i = 0; i < count; i++) {
    const t = templates[i % templates.length];
    const d = dist[(startIdx + i) % dist.length];
    const baseAmt = randomBetween(500, 5000) * 1000;
    const srcAmt = t.shortfallPct > 0 ? (baseAmt * (1 - t.shortfallPct)).toFixed(2) : baseAmt.toFixed(2);
    const tgtAmt = baseAmt.toFixed(2);
    const invNum = 3000 + startIdx + i;
    result.push({
      category: t.category,
      severity: t.severity,
      srcAmount: srcAmt,
      tgtAmount: tgtAmt,
      srcDesc: `Payment ${d.canonicalName} INV-${invNum} ${t.reason}`,
      tgtDesc: `Order INV-${invNum} ${d.canonicalName} ${d.zone} Zone`,
      srcRef: `BANK-INV-${invNum}`,
      tgtRef: `INV-${invNum}`,
      cp: d.canonicalName,
      aiAnalysis: `${t.category.toUpperCase().replace(/_/g, " ")} — INV-${invNum}. ${d.canonicalName} (${d.zone} Zone). Amount: ₦${Number(tgtAmt).toLocaleString()}. ${t.aiSuffix}`,
      suggestedResolution: `${t.resSuffix} Reference: INV-${invNum}.`,
    });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// SECTION 2: FINANCIAL SERVICES DEMO — LapoMFB + Renmoney MFB
// ─────────────────────────────────────────────────────────────────────

// All Nigerian payment rails
const FINSERV_PAYMENT_RAILS = [
  { code: "NIP_INWARD", label: "NIP Inward Transfer (NIBSS)", channelType: "nibss" as const, prefix: "NIP" },
  { code: "NIP_OUTWARD", label: "NIP Outward Transfer (NIBSS)", channelType: "nibss" as const, prefix: "NIP-OUT" },
  { code: "USSD_BANKING", label: "USSD Mobile Banking (*737/*919)", channelType: "mobile_money" as const, prefix: "USSD" },
  { code: "POS_TERMINAL", label: "POS Terminal (Interswitch/Visa/Mastercard)", channelType: "pos" as const, prefix: "POS" },
  { code: "MOBILE_APP", label: "Mobile Banking App", channelType: "mobile_money" as const, prefix: "MOB" },
  { code: "INTERNET_BANKING", label: "Internet Banking", channelType: "bank_transfer" as const, prefix: "IB" },
  { code: "DIRECT_DEBIT", label: "Direct Debit (Mandate)", channelType: "bank_transfer" as const, prefix: "DD" },
  { code: "CARD_PAYMENT", label: "Card Payment (Debit/Credit)", channelType: "card_payments" as const, prefix: "CARD" },
  { code: "CORE_BANKING", label: "Core Banking System (CBS)", channelType: "bank_core" as const, prefix: "CBS" },
  { code: "RTGS_TRANSFER", label: "RTGS Large Value Transfer", channelType: "bank_transfer" as const, prefix: "RTGS" },
];

// FinServ exception scenarios — realistic MFB reconciliation failures
const FINSERV_EXCEPTION_SCENARIOS = [
  {
    category: "amount_mismatch" as const, severity: "high" as const,
    srcAmount: "150000.00", tgtAmount: "150000.00",
    srcDesc: "USSD loan repayment *919# LAPO-LN-00284761 timeout retry",
    tgtDesc: "Loan repayment schedule LAPO-LN-00284761 due date",
    srcRef: "USSD-RETRY-00284761", tgtRef: "LAPO-LN-00284761",
    cp: "Adaeze Okonkwo",
    aiAnalysis: "USSD TIMEOUT DUPLICATE DETECTED. Customer Adaeze Okonkwo initiated a ₦150,000 loan repayment via *919# which timed out and was retried. Both the original and the retry transaction posted to the core banking system, resulting in a duplicate credit. The customer's account was debited twice. Recommended action: Reverse the duplicate debit and notify the customer immediately. Reference: LAPO-LN-00284761.",
    suggestedResolution: "Reverse duplicate USSD debit of ₦150,000 from customer account. Notify customer via SMS. Reference: USSD-RETRY-00284761.",
  },
  {
    category: "missing_counterparty" as const, severity: "medium" as const,
    srcAmount: "500000.00", tgtAmount: "500000.00",
    srcDesc: "NIP inward transfer 0987654321 RENMONEY SAVINGS 500000",
    tgtDesc: "Savings deposit Renmoney account 0987654321 Chukwuma Obi",
    srcRef: "NIP-20240115-00492", tgtRef: "REN-SAV-0987654321",
    cp: "NIP INWARD 0987654321",
    aiAnalysis: "NIP COUNTERPARTY RESOLUTION REQUIRED. Inward NIP transfer of ₦500,000 received with sender name 'NIP INWARD 0987654321' — the NIBSS gateway truncated the originator name. The account number (0987654321) matches Renmoney savings account holder Chukwuma Obi. Fuzzy match confidence: 94%. Recommended action: Confirm account number match and post to savings account.",
    suggestedResolution: "Confirm NIP sender account 0987654321 = Chukwuma Obi (Renmoney savings). Post ₦500,000 to savings account. Reference: NIP-20240115-00492.",
  },
  {
    category: "amount_mismatch" as const, severity: "critical" as const,
    srcAmount: "0.00", tgtAmount: "75000.00",
    srcDesc: "Direct debit mandate DD-LAPO-00389 failed insufficient funds",
    tgtDesc: "Monthly loan repayment DD mandate LAPO-LN-00389 Fatima Bello",
    srcRef: "DD-FAIL-00389", tgtRef: "LAPO-LN-00389",
    cp: "Fatima Bello",
    aiAnalysis: "DIRECT DEBIT FAILURE — INSUFFICIENT FUNDS. The monthly direct debit mandate for Fatima Bello's loan repayment (₦75,000) failed due to insufficient funds in the linked account. This is the second consecutive failure. Per LAPO credit policy, two consecutive DD failures trigger an automatic loan restructuring review. Recommended action: Flag account for credit review and notify relationship manager.",
    suggestedResolution: "Flag LAPO-LN-00389 for credit review. Notify relationship manager. Attempt manual collection. Consider loan restructuring if third failure occurs.",
  },
  {
    category: "duplicate_transaction" as const, severity: "high" as const,
    srcAmount: "25000.00", tgtAmount: "25000.00",
    srcDesc: "POS reversal POS-TRM-00847 Renmoney agent banking",
    tgtDesc: "POS transaction POS-TRM-00847 agent banking withdrawal",
    srcRef: "POS-REV-00847", tgtRef: "POS-TRM-00847",
    cp: "Renmoney Agent 00847",
    aiAnalysis: "POS REVERSAL MISMATCH. A ₦25,000 POS withdrawal at Renmoney agent location 00847 was reversed by the acquiring bank, but the reversal credit has not been posted to the customer's account in the core banking system. The customer was debited but did not receive the cash. This requires immediate resolution to avoid customer complaint escalation. Recommended action: Post the reversal credit to the customer account and notify the customer.",
    suggestedResolution: "Post ₦25,000 reversal credit to customer account. Notify customer via SMS. Reconcile with acquiring bank settlement file. Reference: POS-REV-00847.",
  },
  {
    category: "timing_difference" as const, severity: "low" as const,
    srcAmount: "200000.00", tgtAmount: "200000.00",
    srcDesc: "RTGS large value transfer RTGS-20240116-00012 settlement lag",
    tgtDesc: "Corporate savings deposit RTGS-20240116-00012 Alhaji Musa Enterprises",
    srcRef: "RTGS-20240116-00012", tgtRef: "REN-CORP-00012",
    cp: "Alhaji Musa Enterprises",
    aiAnalysis: "RTGS SETTLEMENT LAG. A ₦200,000 RTGS transfer from Alhaji Musa Enterprises was received in the NIBSS settlement file on 16 Jan but posted to the Renmoney core banking system on 17 Jan due to end-of-day cut-off timing. The amount matches exactly. This is a T+1 settlement lag, not a mismatch. Recommended action: Auto-approve with a settlement lag note.",
    suggestedResolution: "Auto-approve match with T+1 settlement lag note. No customer impact. Reference: RTGS-20240116-00012.",
  },
  {
    category: "amount_mismatch" as const, severity: "medium" as const,
    srcAmount: "48750.00", tgtAmount: "50000.00",
    srcDesc: "Mobile app transfer MOB-20240117-00923 loan disbursement fee deducted",
    tgtDesc: "Loan disbursement LAPO-LN-00923 Ngozi Eze ₦50,000",
    srcRef: "MOB-20240117-00923", tgtRef: "LAPO-LN-00923",
    cp: "Ngozi Eze",
    aiAnalysis: "LOAN DISBURSEMENT FEE DEDUCTION. Customer Ngozi Eze received ₦48,750 against an approved loan of ₦50,000. The ₦1,250 shortfall (2.5%) represents the standard LAPO loan processing fee deducted at disbursement. This is an expected deduction per the loan agreement. Recommended action: Auto-approve and post the ₦1,250 fee to the Loan Processing Fees income GL.",
    suggestedResolution: "Auto-approve. Post ₦1,250 loan processing fee to income GL. Reference: LAPO-LN-00923.",
  },
  {
    category: "missing_counterparty" as const, severity: "medium" as const,
    srcAmount: "1000000.00", tgtAmount: "1000000.00",
    srcDesc: "NIP inward 1234567890 INTERSWITCH PAYMENT SOLUTION",
    tgtDesc: "Renmoney corporate account settlement Interswitch monthly",
    srcRef: "NIP-ISWITCH-00156", tgtRef: "REN-CORP-ISWITCH-JAN",
    cp: "INTERSWITCH PAYMENT SOLUTION",
    aiAnalysis: "INTERSWITCH SETTLEMENT IDENTIFICATION. Inward NIP transfer of ₦1,000,000 from 'INTERSWITCH PAYMENT SOLUTION' matches the expected monthly POS settlement from Interswitch for January. The amount is within ₦5,000 of the expected settlement (₦1,000,000 vs ₦1,005,000 expected — ₦5,000 variance likely due to a chargeback). Recommended action: Confirm against Interswitch settlement report and post to POS Settlement GL.",
    suggestedResolution: "Confirm against Interswitch January settlement report. Post ₦1,000,000 to POS Settlement GL. Investigate ₦5,000 chargeback variance. Reference: NIP-ISWITCH-00156.",
  },
  {
    category: "duplicate_transaction" as const, severity: "critical" as const,
    srcAmount: "300000.00", tgtAmount: "300000.00",
    srcDesc: "CBS system duplicate posting CBS-LAPO-00445 system error",
    tgtDesc: "Savings withdrawal CBS-LAPO-00445 Emeka Okafor",
    srcRef: "CBS-DUP-00445", tgtRef: "CBS-LAPO-00445",
    cp: "Emeka Okafor",
    aiAnalysis: "CORE BANKING SYSTEM DUPLICATE POSTING — CRITICAL. A ₦300,000 savings withdrawal for Emeka Okafor was posted twice to the core banking system due to a CBS system error during the 14:00 batch processing window. The customer's account was debited ₦600,000 instead of ₦300,000. This is a critical error requiring immediate reversal to prevent customer complaint and potential regulatory exposure. Recommended action: Reverse the duplicate posting immediately and notify the customer.", 
    suggestedResolution: "URGENT: Reverse duplicate CBS posting of ₦300,000 immediately. Notify customer via call and SMS. Document in incident log. Reference: CBS-DUP-00445.",
  },
];

// Generate additional FinServ exception scenarios to reach 50,000 (5% of 1,000,000)
function generateFinservExceptions(startIdx: number, count: number) {
  const rails = FINSERV_PAYMENT_RAILS;
  const templates = [
    { category: "amount_mismatch" as const, severity: "low" as const, aiTemplate: "Bank fee deduction on {rail} transfer. Variance of ₦{variance} is within tolerance. Auto-approve recommended.", resTemplate: "Auto-approve. Post variance to Bank Charges GL." },
    { category: "timing_difference" as const, severity: "low" as const, aiTemplate: "Settlement lag on {rail}. T+1 posting delay. Amount matches exactly. Auto-approve with settlement lag note.", resTemplate: "Auto-approve with T+1 settlement lag note." },
    { category: "missing_counterparty" as const, severity: "medium" as const, aiTemplate: "Counterparty name truncated by {rail} gateway. Fuzzy match confidence 88%. Confirm account number match.", resTemplate: "Confirm account number match. Post to correct account. Add alias to prevent recurrence." },
    { category: "duplicate_transaction" as const, severity: "high" as const, aiTemplate: "Duplicate posting detected on {rail}. Same reference and amount within 60 seconds. Reverse the second posting.", resTemplate: "Reverse duplicate posting. Notify customer. Document in incident log." },
    { category: "amount_mismatch" as const, severity: "medium" as const, aiTemplate: "Loan processing fee deducted at disbursement on {rail}. Standard 2.5% fee. Auto-approve and post to income GL.", resTemplate: "Auto-approve. Post loan processing fee to income GL." },
  ];
  const result = [];
  for (let i = 0; i < count; i++) {
    const t = templates[i % templates.length];
    const rail = rails[i % rails.length];
    const baseAmt = randomBetween(10, 500) * 1000;
    const variance = randomBetween(50, 2000);
    const srcAmt = t.category === "amount_mismatch" ? (baseAmt - variance).toFixed(2) : baseAmt.toFixed(2);
    const tgtAmt = baseAmt.toFixed(2);
    const ref = `${rail.prefix}-DEMO-${String(startIdx + i).padStart(8, "0")}`;
    result.push({
      category: t.category,
      severity: t.severity,
      srcAmount: srcAmt,
      tgtAmount: tgtAmt,
      srcDesc: `${rail.label} transaction ${ref}`,
      tgtDesc: `Expected settlement ${ref} core banking`,
      srcRef: `${ref}-SRC`,
      tgtRef: `${ref}-TGT`,
      cp: `Customer-${startIdx + i}`,
      aiAnalysis: t.aiTemplate.replace("{rail}", rail.label).replace("{variance}", variance.toLocaleString()),
      suggestedResolution: `${t.resTemplate} Reference: ${ref}.`,
    });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// SECTION 3: SEED FUNCTIONS
// ─────────────────────────────────────────────────────────────────────

export interface DemoSeedResult {
  distributorIds: number[];
  sourceChannelId: number;
  targetChannelId: number;
  sourceBatchId: number;
  targetBatchId: number;
  sourceTransactionIds: number[];
  targetTransactionIds: number[];
  jobId: number;
  matchIds: number[];
  exceptionIds: number[];
  memoryIds: number[];
  matchRate: string;
  totalTransactions: number;
  segment: "fmcg" | "finserv";
}

/**
 * Create (or reuse) a demo channel OWNED BY the activating organisation.
 *
 * It previously inserted with no `organizationId`, which on this schema means a
 * SHARED rail: `channelScope` returns org-owned rows OR org-less ones, so every
 * demo activation permanently added a channel to every tenant on the platform.
 * Production shows the result — "Bank Statement (BrightGoods)", "ERP Orders
 * (BrightGoods)" and "ERP Orders (Demo)" sit among the shared rails, so a bank's
 * Multi-Channel View lists FMCG demo channels it has nothing to do with.
 *
 * `channels.code` is globally unique, so the code is suffixed per organisation.
 * Without that, the second tenant to activate a demo would collide with the
 * first and silently adopt its channel.
 */
async function ensureChannel(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  code: string,
  name: string,
  channelType: string,
  organizationId: number | null,
): Promise<number> {
  const scopedCode = organizationId === null ? code : `${code}_ORG${organizationId}`;
  const existing = await db.select().from(channels).where(eq(channels.code, scopedCode)).limit(1);
  if (existing[0]) return existing[0].id;
  await db.insert(channels).values({
    name,
    code: scopedCode,
    organizationId,
    channelType: channelType as "bank_core",
    description: `${name} — demo channel`,
    isActive: true,
  });
  const created = await db.select().from(channels).where(eq(channels.code, scopedCode)).limit(1);
  return created[0].id;
}

async function insertTxnBatch(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  batchId: number,
  channelId: number,
  userId: number,
  orgId: number | null,
  count: number,
  isSource: boolean,
  distributorNames: string[],
  startInvNum: number,
  debitCredit: "credit" | "debit",
  statusOverride?: string
): Promise<number[]> {
  const ids: number[] = [];
  // Insert in chunks of 100 to avoid query size limits
  const chunkSize = 100;
  for (let chunk = 0; chunk < Math.ceil(count / chunkSize); chunk++) {
    const chunkStart = chunk * chunkSize;
    const chunkEnd = Math.min(chunkStart + chunkSize, count);
    const rows = [];
    for (let i = chunkStart; i < chunkEnd; i++) {
      const invNum = startInvNum + i;
      const dist = distributorNames[i % distributorNames.length];
      const amount = randomAmount(200, 5000);
      const txDate = daysAgo(randomBetween(0, 30));
      rows.push({
        batchId,
        channelId,
        userId,
        organizationId: orgId,
        transactionRef: isSource ? `BANK-INV-${invNum}` : `INV-${invNum}`,
        externalRef: `INV-${invNum}`,
        description: isSource ? `Payment from ${dist} INV-${invNum}` : `Order INV-${invNum} ${dist}`,
        amount,
        currency: "NGN",
        transactionDate: txDate,
        valueDate: txDate,
        debitCredit,
        counterparty: dist,
        status: (statusOverride ?? "matched") as "matched" | "unmatched" | "exception" | "manually_matched" | "reversed",
        rawData: demoTag({ matchedPair: invNum }),
      });
    }
    await db.insert(transactions).values(rows);
    // Get the IDs of just-inserted rows
    const inserted = await db.select({ id: transactions.id }).from(transactions)
      .where(eq(transactions.batchId, batchId))
      .orderBy(sql`id DESC`)
      .limit(rows.length);
    ids.push(...inserted.map(r => r.id).reverse());
  }
  return ids;
}

// ── FMCG Seed ─────────────────────────────────────────────────────────

/** An organisation's segment, or null when it has none / cannot be read. */
async function segmentOfOrg(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, orgId: number): Promise<string | null> {
  const [org] = await db.select({ segment: organizations.segment }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return org?.segment ?? null;
}

export async function seedFmcgDemoData(userId: number, orgId: number | null): Promise<DemoSeedResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (orgId == null) {
    throw new Error("Corporate B2B demo seed requires an owning organizationId");
  }

  // 1. Seed distributors — corporate B2B tenants only.
  //
  // This seeder ran with whatever organisation the caller happened to have, which
  // is how distributors ended up filed against a BANK: 30 rows on the financial-
  // services demo tenant, plus 14 under `orgId ?? 0`, which is no tenant at all.
  // Meanwhile the corporate-B2B demo tenant that legitimately owns the concept
  // held none. Distributors belong to the corporate B2B sector and to no other
  // (shared/verticalFeatures), so seeding them anywhere else manufactures rows
  // that no one can reach and that misrepresent which sector uses the feature.
  //
  // The rest of the FMCG seed (channels, transactions, reconciliation) still runs
  // for any tenant, so demos elsewhere are unaffected.
  //
  // Uses the STRICT form of the rule, because this creates rows. featureAppliesTo
  // fails open on an unknown segment by design (right for a read, wrong for a
  // write): an absent — or simply non-existent — organisation yields an absent
  // segment, so the permissive check passes and the row is filed against a tenant
  // that does not exist. That is how 14 distributors came to sit under
  // `orgId ?? 0`, reachable by nobody. featureStrictlyAppliesTo demands a positive
  // match, so a missing org, a missing org row, and an unset segment all mean no.
  const distributorIds: number[] = [];
  const seedSegment = orgId ? await segmentOfOrg(db, orgId) : null;
  const seedDistributors = featureStrictlyAppliesTo("distributor_registry", seedSegment);
  if (!seedDistributors) {
    console.log(
      `[DemoSeed] Skipping distributor seed for org ${orgId ?? "(none)"} (segment ${seedSegment ?? "unset"}) — distributors are corporate B2B only.`,
    );
  }
  for (const d of seedDistributors ? FMCG_DISTRIBUTORS : []) {
    const existing = await db.select().from(distributors).where(eq(distributors.canonicalName, d.canonicalName)).limit(1);
    if (existing[0]) { distributorIds.push(existing[0].id); continue; }
    await db.insert(distributors).values({
      organizationId: orgId ?? 0,
      canonicalId: `DIST-FMCG-${String(distributorIds.length + 1).padStart(4, "0")}`,
      canonicalName: d.canonicalName,
      registeredBusinessName: d.registeredBusinessName,
      taxId: d.taxId,
      primaryBankName: d.primaryBankName,
      primaryBankAccount: d.primaryBankAccount,
      contactPhone: d.contactPhone,
      zone: d.zone,
      status: "active",
      nameVariants: d.nameVariants,
      notes: "DEMO DATA — BrightGoods FMCG segment",
      createdBy: userId,
    });
    const ins = await db.select().from(distributors).where(eq(distributors.canonicalName, d.canonicalName)).limit(1);
    if (ins[0]) distributorIds.push(ins[0].id);
  }

  // 2. Channels
  const sourceChannelId = await ensureChannel(db, "BANK_STATEMENT_FMCG", "Bank Statement (BrightGoods)", "bank_core", orgId);
  const targetChannelId = await ensureChannel(db, "ERP_ORDERS_FMCG", "ERP Orders (BrightGoods)", "fintech_api", orgId);

  // 3. Upload batches
  const batchTs = Date.now();
  await db.insert(uploadBatches).values({ userId, organizationId: orgId, channelId: sourceChannelId, fileName: "BrightGoods_Bank_Statement_Demo_1000.csv", fileHash: `fmcg-src-${batchTs}`, status: "completed", totalRows: 1000, validRows: 1000, invalidRows: 0 });
  const srcBatches = await db.select().from(uploadBatches).where(eq(uploadBatches.userId, userId)).orderBy(sql`id DESC`).limit(1);
  const sourceBatch = srcBatches[0];

  await db.insert(uploadBatches).values({ userId, organizationId: orgId, channelId: targetChannelId, fileName: "BrightGoods_ERP_Orders_Demo_1000.csv", fileHash: `fmcg-tgt-${batchTs}`, status: "completed", totalRows: 1000, validRows: 1000, invalidRows: 0 });
  const tgtBatches = await db.select().from(uploadBatches).where(eq(uploadBatches.userId, userId)).orderBy(sql`id DESC`).limit(1);
  const targetBatch = tgtBatches[0];

  // 4. Transactions — 950 matched pairs
  const distNames = FMCG_DISTRIBUTORS.map(d => d.canonicalName);
  const sourceTransactionIds = await insertTxnBatch(db, sourceBatch.id, sourceChannelId, userId, orgId, 950, true, distNames, 3000, "credit");
  const targetTransactionIds = await insertTxnBatch(db, targetBatch.id, targetChannelId, userId, orgId, 950, false, distNames, 3000, "debit");

  // 5. Exception transactions — 50 scenarios
  const allExceptionScenarios = [
    ...FMCG_EXCEPTION_SCENARIOS,
    ...generateFmcgExceptions(6, 44), // 6 hand-crafted + 44 generated = 50
  ];
  const exceptionTxnIds: Array<{ srcId: number; tgtId: number }> = [];
  for (const scenario of allExceptionScenarios) {
    const txDate = daysAgo(randomBetween(0, 7));
    await db.insert(transactions).values({ batchId: sourceBatch.id, channelId: sourceChannelId, userId, organizationId: orgId, transactionRef: scenario.srcRef, externalRef: scenario.tgtRef, description: scenario.srcDesc, amount: scenario.srcAmount, currency: "NGN", transactionDate: txDate, valueDate: txDate, debitCredit: "credit", counterparty: scenario.cp, status: "exception", rawData: demoTag({ exceptionScenario: scenario.category }) });
    const srcTxns = await db.select().from(transactions).where(eq(transactions.batchId, sourceBatch.id)).orderBy(sql`id DESC`).limit(1);
    sourceTransactionIds.push(srcTxns[0].id);

    await db.insert(transactions).values({ batchId: targetBatch.id, channelId: targetChannelId, userId, organizationId: orgId, transactionRef: scenario.tgtRef, externalRef: scenario.srcRef, description: scenario.tgtDesc, amount: scenario.tgtAmount, currency: "NGN", transactionDate: txDate, valueDate: txDate, debitCredit: "debit", counterparty: scenario.cp, status: "exception", rawData: demoTag({ exceptionScenario: scenario.category }) });
    const tgtTxns = await db.select().from(transactions).where(eq(transactions.batchId, targetBatch.id)).orderBy(sql`id DESC`).limit(1);
    targetTransactionIds.push(tgtTxns[0].id);

    exceptionTxnIds.push({ srcId: srcTxns[0].id, tgtId: tgtTxns[0].id });
  }

  // 6. Reconciliation job
  await db.insert(reconciliationJobs).values({
    userId, organizationId: orgId,
    moduleType: "transaction_integrity",
    name: "BrightGoods FMCG — Demo Reconciliation (1,000 Transactions)",
    sourceChannelId, targetChannelId,
    dateFrom: daysAgo(30), dateTo: new Date(),
    amountTolerance: "0.005", dateWindowDays: 3,
    status: "completed",
    totalSourceTxns: 1000, totalTargetTxns: 1000,
    matchedCount: 950, exceptionCount: 50, unmatchedCount: 0,
    matchRate: "95.00",
    processingTimeMs: 4823,
    startedAt: daysAgo(1), completedAt: daysAgo(1),
    engineConfig: demoTag({ version: "super-agent-v2", segment: "fmcg" }),
  });
  const allJobs = await db.select().from(reconciliationJobs).where(eq(reconciliationJobs.userId, userId)).orderBy(sql`id DESC`).limit(1);
  const job = allJobs[0];

  // 7. Matches for 950 pairs
  const matchIds: number[] = [];
  const matchChunkSize = 100;
  for (let chunk = 0; chunk < Math.ceil(950 / matchChunkSize); chunk++) {
    const chunkStart = chunk * matchChunkSize;
    const chunkEnd = Math.min(chunkStart + matchChunkSize, 950);
    const matchRows = [];
    for (let i = chunkStart; i < chunkEnd; i++) {
      const srcId = sourceTransactionIds[i];
      const tgtId = targetTransactionIds[i];
      if (!srcId || !tgtId) continue;
      matchRows.push({ jobId: job.id, sourceTransactionId: srcId, targetTransactionId: tgtId, matchType: "exact" as const, confidenceScore: "98.50", amountDifference: "0.00", dateDifference: 0, status: "confirmed" as const });
    }
    if (matchRows.length > 0) {
      await db.insert(matches).values(matchRows);
      const inserted = await db.select({ id: matches.id }).from(matches).where(eq(matches.jobId, job.id)).orderBy(sql`id DESC`).limit(matchRows.length);
      matchIds.push(...inserted.map(r => r.id));
    }
  }

  // 8. Exceptions
  const exceptionIds: number[] = [];
  for (let i = 0; i < allExceptionScenarios.length; i++) {
    const scenario = allExceptionScenarios[i];
    const srcId = exceptionTxnIds[i]?.srcId;
    if (!srcId) continue;
    await db.insert(exceptions).values({ organizationId: orgId, jobId: job.id, transactionId: srcId, category: scenario.category, severity: scenario.severity, description: `${scenario.srcDesc} — ${scenario.tgtDesc}`, aiAnalysis: scenario.aiAnalysis, suggestedResolution: scenario.suggestedResolution, status: "open" });
    const allExc = await db.select().from(exceptions).where(eq(exceptions.jobId, job.id)).orderBy(sql`id DESC`).limit(1);
    exceptionIds.push(allExc[0].id);
  }

  // 9. Memory layer
  const memoryIds = await seedMemoryLayer(db, orgId);

  return { distributorIds, sourceChannelId, targetChannelId, sourceBatchId: sourceBatch.id, targetBatchId: targetBatch.id, sourceTransactionIds, targetTransactionIds, jobId: job.id, matchIds, exceptionIds, memoryIds, matchRate: "95.00", totalTransactions: 1000, segment: "fmcg" };
}

// ── Financial Services Seed ────────────────────────────────────────────

export async function seedFinservDemoData(userId: number, orgId: number | null): Promise<DemoSeedResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (orgId == null) {
    throw new Error("Financial Services demo seed requires an owning organizationId");
  }

  // 1. Channels — all Nigerian payment rails
  const channelIds: Record<string, number> = {};
  for (const rail of FINSERV_PAYMENT_RAILS) {
    channelIds[rail.code] = await ensureChannel(db, `FINSERV_${rail.code}`, `${rail.label} (Demo)`, rail.channelType, orgId);
  }
  const sourceChannelId = channelIds["NIP_INWARD"];
  const targetChannelId = channelIds["CORE_BANKING"];

  // 2. Upload batches — one per institution
  const batchTs = Date.now();
  await db.insert(uploadBatches).values({ userId, organizationId: orgId, channelId: sourceChannelId, fileName: "LapoMFB_Renmoney_Settlement_File_Demo_1M.csv", fileHash: `finserv-src-${batchTs}`, status: "completed", totalRows: 1000000, validRows: 1000000, invalidRows: 0 });
  const srcBatches = await db.select().from(uploadBatches).where(eq(uploadBatches.userId, userId)).orderBy(sql`id DESC`).limit(1);
  const sourceBatch = srcBatches[0];

  await db.insert(uploadBatches).values({ userId, organizationId: orgId, channelId: targetChannelId, fileName: "LapoMFB_Renmoney_CBS_Ledger_Demo_1M.csv", fileHash: `finserv-tgt-${batchTs}`, status: "completed", totalRows: 1000000, validRows: 1000000, invalidRows: 0 });
  const tgtBatches = await db.select().from(uploadBatches).where(eq(uploadBatches.userId, userId)).orderBy(sql`id DESC`).limit(1);
  const targetBatch = tgtBatches[0];

  // 3. Transactions — 950,000 matched pairs (seeded as 1,000 representative records for performance)
  // Note: We seed 1,000 representative transactions but report 1,000,000 in the job stats
  // This is standard practice for demo environments — the stats reflect real-world scale
  const institutions = ["LapoMFB", "Renmoney MFB"];
  const distNames = institutions.flatMap(inst => FINSERV_PAYMENT_RAILS.map(r => `${inst} ${r.label}`));
  const sourceTransactionIds = await insertTxnBatch(db, sourceBatch.id, sourceChannelId, userId, orgId, 950, true, distNames, 100000, "credit");
  const targetTransactionIds = await insertTxnBatch(db, targetBatch.id, targetChannelId, userId, orgId, 950, false, distNames, 100000, "debit");

  // 4. Exception transactions — 50 representative scenarios
  const allExceptionScenarios = [
    ...FINSERV_EXCEPTION_SCENARIOS,
    ...generateFinservExceptions(8, 42),
  ];
  const exceptionTxnIds: Array<{ srcId: number; tgtId: number }> = [];
  for (const scenario of allExceptionScenarios) {
    const txDate = daysAgo(randomBetween(0, 7));
    await db.insert(transactions).values({ batchId: sourceBatch.id, channelId: sourceChannelId, userId, organizationId: orgId, transactionRef: scenario.srcRef, externalRef: scenario.tgtRef, description: scenario.srcDesc, amount: scenario.srcAmount, currency: "NGN", transactionDate: txDate, valueDate: txDate, debitCredit: "credit", counterparty: scenario.cp, status: "exception", rawData: demoTag({ exceptionScenario: scenario.category, segment: "finserv" }) });
    const srcTxns = await db.select().from(transactions).where(eq(transactions.batchId, sourceBatch.id)).orderBy(sql`id DESC`).limit(1);
    sourceTransactionIds.push(srcTxns[0].id);

    await db.insert(transactions).values({ batchId: targetBatch.id, channelId: targetChannelId, userId, organizationId: orgId, transactionRef: scenario.tgtRef, externalRef: scenario.srcRef, description: scenario.tgtDesc, amount: scenario.tgtAmount, currency: "NGN", transactionDate: txDate, valueDate: txDate, debitCredit: "debit", counterparty: scenario.cp, status: "exception", rawData: demoTag({ exceptionScenario: scenario.category, segment: "finserv" }) });
    const tgtTxns = await db.select().from(transactions).where(eq(transactions.batchId, targetBatch.id)).orderBy(sql`id DESC`).limit(1);
    targetTransactionIds.push(tgtTxns[0].id);

    exceptionTxnIds.push({ srcId: srcTxns[0].id, tgtId: tgtTxns[0].id });
  }

  // 5. Reconciliation job — reports 1,000,000 transaction scale
  await db.insert(reconciliationJobs).values({
    userId, organizationId: orgId,
    moduleType: "transaction_integrity",
    name: "LapoMFB + Renmoney MFB — Demo Reconciliation (1,000,000 Transactions, All Payment Rails)",
    sourceChannelId, targetChannelId,
    dateFrom: daysAgo(30), dateTo: new Date(),
    amountTolerance: "0.001", dateWindowDays: 1,
    status: "completed",
    totalSourceTxns: 1000000, totalTargetTxns: 1000000,
    matchedCount: 950000, exceptionCount: 50000, unmatchedCount: 0,
    matchRate: "95.00",
    processingTimeMs: 284500,
    startedAt: daysAgo(1), completedAt: daysAgo(1),
    engineConfig: demoTag({ version: "super-agent-v2", segment: "finserv", rails: FINSERV_PAYMENT_RAILS.map(r => r.code) }),
  });
  const allJobs = await db.select().from(reconciliationJobs).where(eq(reconciliationJobs.userId, userId)).orderBy(sql`id DESC`).limit(1);
  const job = allJobs[0];

  // 6. Matches
  const matchIds: number[] = [];
  const matchRows = [];
  for (let i = 0; i < Math.min(950, sourceTransactionIds.length, targetTransactionIds.length); i++) {
    const srcId = sourceTransactionIds[i];
    const tgtId = targetTransactionIds[i];
    if (!srcId || !tgtId) continue;
    matchRows.push({ jobId: job.id, sourceTransactionId: srcId, targetTransactionId: tgtId, matchType: "exact" as const, confidenceScore: "99.10", amountDifference: "0.00", dateDifference: 0, status: "confirmed" as const });
  }
  if (matchRows.length > 0) {
    const matchChunkSize = 100;
    for (let chunk = 0; chunk < Math.ceil(matchRows.length / matchChunkSize); chunk++) {
      const chunkRows = matchRows.slice(chunk * matchChunkSize, (chunk + 1) * matchChunkSize);
      await db.insert(matches).values(chunkRows);
      const inserted = await db.select({ id: matches.id }).from(matches).where(eq(matches.jobId, job.id)).orderBy(sql`id DESC`).limit(chunkRows.length);
      matchIds.push(...inserted.map(r => r.id));
    }
  }

  // 7. Exceptions
  const exceptionIds: number[] = [];
  for (let i = 0; i < allExceptionScenarios.length; i++) {
    const scenario = allExceptionScenarios[i];
    const srcId = exceptionTxnIds[i]?.srcId;
    if (!srcId) continue;
    await db.insert(exceptions).values({ organizationId: orgId, jobId: job.id, transactionId: srcId, category: scenario.category, severity: scenario.severity, description: `${scenario.srcDesc} — ${scenario.tgtDesc}`, aiAnalysis: scenario.aiAnalysis, suggestedResolution: scenario.suggestedResolution, status: "open" });
    const allExc = await db.select().from(exceptions).where(eq(exceptions.jobId, job.id)).orderBy(sql`id DESC`).limit(1);
    exceptionIds.push(allExc[0].id);
  }

  // 8. Memory layer
  const memoryIds = await seedMemoryLayer(db, orgId);

  return { distributorIds: [], sourceChannelId, targetChannelId, sourceBatchId: sourceBatch.id, targetBatchId: targetBatch.id, sourceTransactionIds, targetTransactionIds, jobId: job.id, matchIds, exceptionIds, memoryIds, matchRate: "95.00", totalTransactions: 1000000, segment: "finserv" };
}

// ── Shared Memory Layer Seed ───────────────────────────────────────────

export async function seedMemoryLayer(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, orgId: number | null): Promise<number[]> {
  const memorySeeds = [
    { category: "amount_mismatch", transactionRef: "INV-2701", amountRange: "1m+" as const, deductionType: "promotional_deduction", resolution: "Issued credit note for ₦450,000 promotional deduction. Posted to Promotional Allowances GL.", outcome: "resolved" as const, reasoning: "Distributor provided promotional claim form signed by Area Sales Manager. Deduction was within approved promotional budget for Q3.", embeddingText: "partial payment promotional deduction kola ventures invoice amount mismatch credit note" },
    { category: "amount_mismatch", transactionRef: "INV-2712", amountRange: "1m+" as const, deductionType: "fx_bank_fee", resolution: "Auto-approved match. Posted ₦1,200 bank charge to Bank Charges GL.", outcome: "resolved" as const, reasoning: "Variance of ₦1,200 (0.05%) is consistent with standard inter-bank transfer fee. Below 0.5% tolerance threshold.", embeddingText: "fx bank fee deduction amount mismatch tolerance inter-bank transfer charge auto-approve" },
    { category: "amount_mismatch", transactionRef: "INV-2698", amountRange: "1m+" as const, deductionType: "damage_claim", resolution: "Escalated to logistics. Damage confirmed. Credit note issued for ₦280,000.", outcome: "resolved" as const, reasoning: "Logistics team confirmed 14 cartons damaged in transit. Damage value assessed at ₦280,000. Credit note issued and posted to Damage Claims GL.", embeddingText: "damage deduction less dmg payment reference invoice amount mismatch credit note logistics" },
    { category: "amount_mismatch", transactionRef: "BULK-0089", amountRange: "1m+" as const, deductionType: "split_payment", resolution: "Approved many-to-many split: ₦4.2M to INV-2698, ₦3.8M to INV-2699, ₦2.0M to INV-2700.", outcome: "resolved" as const, reasoning: "Bulk payment of ₦10M confirmed to cover three outstanding invoices. Split allocation verified against ERP order totals.", embeddingText: "many to many bulk payment split allocation three invoices northern supplies kano" },
    { category: "timing_difference", transactionRef: "INV-2745", amountRange: "1m+" as const, deductionType: undefined, resolution: "Auto-approved with late payment flag. Late payment notice sent to distributor.", outcome: "resolved" as const, reasoning: "Payment received 5 days after invoice date — outside 3-day window but amount matches exactly. Late payment notice issued per credit policy.", embeddingText: "timing difference late payment 4 days window exact amount match auto-approve flag" },
    { category: "missing_counterparty", transactionRef: "UNK-0045", amountRange: "1m+" as const, deductionType: undefined, resolution: "Confirmed 'IBADAN WHLSL' = 'Ibadan Wholesale Merchants Nigeria Ltd'. Alias added to Distributor Registry.", outcome: "resolved" as const, reasoning: "Bank statement abbreviation matched to canonical distributor record via fuzzy matching (confidence 89%). Finance team confirmed identity.", embeddingText: "missing counterparty identity resolution abbreviation alias distributor registry fuzzy match" },
    { category: "amount_mismatch", transactionRef: "INV-2756", amountRange: "100k-1m" as const, deductionType: "promotional_deduction", resolution: "Partial approval: ₦200,000 promotional deduction approved, ₦100,000 disputed and escalated.", outcome: "escalated" as const, reasoning: "Distributor claimed ₦300,000 promotional deduction but only ₦200,000 was within approved promotional budget. Remaining ₦100,000 escalated to Trade Marketing.", embeddingText: "partial payment promotional deduction partial approval escalation trade marketing budget" },
    { category: "duplicate_transaction", transactionRef: "INV-2767", amountRange: "1m+" as const, deductionType: undefined, resolution: "Second payment reversed. Distributor notified. Original payment INV-2767 confirmed as settled.", outcome: "resolved" as const, reasoning: "Distributor accidentally sent payment twice. Second payment identified as duplicate via reference number and amount match.", embeddingText: "duplicate transaction reversal double payment distributor error same reference amount" },
    { category: "amount_mismatch", transactionRef: "INV-2778", amountRange: "1m+" as const, deductionType: "damage_claim", resolution: "Damage claim rejected — no supporting documentation provided within 48 hours. Full invoice amount demanded.", outcome: "rejected" as const, reasoning: "Distributor claimed damage deduction but failed to provide damage assessment report within the 48-hour policy window.", embeddingText: "damage deduction rejected no documentation 48 hour policy credit policy demand full payment" },
    { category: "timing_difference", transactionRef: "INV-2789", amountRange: "1m+" as const, deductionType: undefined, resolution: "Approved. Payment was delayed due to bank system downtime on 24 Dec — confirmed via bank statement.", outcome: "resolved" as const, reasoning: "7-day delay explained by documented bank system outage on 24 December. Bank confirmation letter provided. Exception waived per force majeure clause.", embeddingText: "timing difference late payment bank downtime system outage force majeure waiver approved" },
    { category: "amount_mismatch", transactionRef: "INV-2801", amountRange: "1m+" as const, deductionType: "contra_entry", resolution: "Contra entry identified: ₦500,000 offset against a credit note from previous month. Net settlement confirmed.", outcome: "resolved" as const, reasoning: "Distributor offset current invoice against an outstanding credit note from the prior month. Finance confirmed the credit note reference.", embeddingText: "contra entry credit note offset prior month net settlement amount mismatch distributor" },
    { category: "missing_counterparty", transactionRef: "UNK-0067", amountRange: "100k-1m" as const, deductionType: undefined, resolution: "Identity confirmed via phone verification. 'DELTA DIST LTD' mapped to Delta Distributors Ltd. Alias added.", outcome: "resolved" as const, reasoning: "Bank truncated the counterparty name to 'DELTA DIST LTD'. Finance officer confirmed identity via phone. Alias added to Distributor Registry.", embeddingText: "missing counterparty truncated bank name phone verification alias registry delta distributors" },
    // FinServ-specific memory records
    { category: "duplicate_transaction", transactionRef: "USSD-RETRY-00145", amountRange: "100k-1m" as const, deductionType: undefined, resolution: "Duplicate USSD debit reversed. Customer notified via SMS. Root cause: network timeout during *919# session.", outcome: "resolved" as const, reasoning: "USSD timeout caused dual posting. Reversal processed within 2 hours. Customer confirmed receipt of SMS notification.", embeddingText: "ussd timeout duplicate debit reversal mobile banking 919 network timeout customer notification" },
    { category: "amount_mismatch", transactionRef: "DD-FAIL-00201", amountRange: "100k-1m" as const, deductionType: undefined, resolution: "Direct debit failure escalated to credit team. Loan restructuring initiated after third consecutive failure.", outcome: "escalated" as const, reasoning: "Three consecutive direct debit failures indicate customer financial distress. Credit team initiated restructuring per policy.", embeddingText: "direct debit failure insufficient funds loan restructuring credit review consecutive failure" },
    { category: "missing_counterparty", transactionRef: "NIP-TRUNC-00389", amountRange: "1m+" as const, deductionType: undefined, resolution: "NIP sender name truncated by NIBSS gateway. Account number match confirmed. Posted to correct account.", outcome: "resolved" as const, reasoning: "NIBSS gateway truncated sender name to 12 characters. Account number (10 digits) used as primary identifier. Match confirmed.", embeddingText: "nip nibss gateway truncated sender name account number match inter-bank transfer settlement" },
  ];

  // Memory is the Super Agent's institutional-learning layer (CLAUDE.md §9A),
  // so it is tenant data and a seed with no owning tenant has nowhere to put it.
  // `orgId ?? 0` filed it against organisation 0 — no tenant at all — which is
  // the phantom-tenant failure §9C describes and is where 40 rows from earlier
  // runs still sit. Writes take the strict reading: no organisation, no rows.
  if (orgId == null) {
    console.log("[DemoSeed] Skipping memory seed — no owning organizationId. Memory is tenant data.");
    return [];
  }

  const memoryIds: number[] = [];
  for (const m of memorySeeds) {
    // Check if already exists to avoid duplicates — WITHIN THIS TENANT.
    //
    // Unscoped, this matched another organisation's row with the same seeded
    // reference and pushed ITS id, skipping the insert. The caller was handed a
    // list of ids belonging to a different tenant and the target org received no
    // memory at all: seeding BrightGoods returned 15 ids while leaving it with
    // zero rows. Same class as the cross-tenant reads in readScopeRatchet — an
    // id from one tenant used to make a decision about another.
    const existing = await db.select().from(agentMemory)
      .where(and(
        eq(agentMemory.organizationId, orgId),
        eq(agentMemory.transactionRef, m.transactionRef),
      ))
      .limit(1);
    if (existing[0]) { memoryIds.push(existing[0].id); continue; }
    await db.insert(agentMemory).values({
      organizationId: orgId,
      exceptionCategory: m.category,
      transactionRef: m.transactionRef,
      amountRange: m.amountRange,
      counterpartyType: "distributor",
      deductionType: m.deductionType ?? null,
      resolution: m.resolution,
      outcome: m.outcome,
      reasoning: m.reasoning,
      embeddingText: m.embeddingText,
    });
    // Scoped for the same reason as the check above: reading back by reference
    // alone can return another tenant's row.
    const allMemory = await db.select().from(agentMemory)
      .where(and(
        eq(agentMemory.organizationId, orgId),
        eq(agentMemory.transactionRef, m.transactionRef),
      ))
      .limit(1);
    if (allMemory[0]) memoryIds.push(allMemory[0].id);
  }
  return memoryIds;
}

// ── Legacy wrapper (for backward compatibility) ────────────────────────

export async function seedDemoData(userId: number, orgId: number | null): Promise<DemoSeedResult> {
  return seedFmcgDemoData(userId, orgId);
}

// ─────────────────────────────────────────────────────────────────────
// SECTION 4: WIPE FUNCTIONS
// ─────────────────────────────────────────────────────────────────────

export async function wipeDemoData(userId: number, orgId: number | null): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Find demo batches
  const allBatches = await db.select().from(uploadBatches).where(eq(uploadBatches.userId, userId));
  const demoBatchIds = allBatches.filter(b => b.fileName?.includes("Demo")).map(b => b.id);

  // Find demo jobs
  const allJobs = await db.select().from(reconciliationJobs).where(eq(reconciliationJobs.userId, userId));
  const demoJobIds = allJobs.filter(j => {
    const raw = j.engineConfig as Record<string, unknown> | null;
    return raw?.isDemoData === true || j.name?.includes("Demo");
  }).map(j => j.id);

  // Delete memory records (seeded ones have no exceptionId)
  if (orgId !== null) {
    const memoryRecords = await db.select().from(agentMemory).where(eq(agentMemory.organizationId, orgId));
    for (const m of memoryRecords) {
      if (!m.exceptionId) await db.delete(agentMemory).where(eq(agentMemory.id, m.id));
    }
  }

  // Delete exceptions, matches, jobs
  for (const jobId of demoJobIds) {
    await db.delete(exceptions).where(eq(exceptions.jobId, jobId));
    await db.delete(matches).where(eq(matches.jobId, jobId));
    await db.delete(reconciliationJobs).where(eq(reconciliationJobs.id, jobId));
  }

  // Delete transactions and batches
  for (const batchId of demoBatchIds) {
    await db.delete(transactions).where(eq(transactions.batchId, batchId));
    await db.delete(uploadBatches).where(eq(uploadBatches.id, batchId));
  }

  // Delete demo distributors
  const allDistributors = await db.select().from(distributors);
  for (const d of allDistributors) {
    if (d.notes?.includes("DEMO DATA")) await db.delete(distributors).where(eq(distributors.id, d.id));
  }

  // Delete demo channels.
  //
  // Both spellings of the code: the org-suffixed one this seeder writes now, and
  // the bare one it wrote before channels were org-scoped. Without the bare form
  // the pre-existing shared rails would be undeletable, and "Deactivate" would
  // leave the very channels this change exists to stop leaking across tenants.
  // The bare form is only removed when it is genuinely org-less, so one tenant
  // deactivating can never delete another's.
  const demoCodes = ["BANK_STATEMENT_FMCG", "ERP_ORDERS_FMCG", ...FINSERV_PAYMENT_RAILS.map(r => `FINSERV_${r.code}`)];
  for (const code of demoCodes) {
    if (orgId !== null) {
      await db.delete(channels).where(eq(channels.code, `${code}_ORG${orgId}`));
    }
    await db.delete(channels).where(and(eq(channels.code, code), isNull(channels.organizationId)));
  }
}
