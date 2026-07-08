/**
 * Mobile Banking / USSD / Agent Banking — exception taxonomy.
 *
 * These channels represent the primary access points for financial
 * inclusion in Nigeria. Mobile banking apps, USSD (*737#, *901#, etc.),
 * and agent banking (Moniepoint, OPay, FirstMonie, etc.) each have
 * unique exception patterns. Based on CBN Agent Banking Guidelines,
 * CBN USSD Payment Regulations, and mobile banking operational standards.
 */
import type { NigerianChannelException } from "./types";

export const MOBILE_CHANNEL_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "ussd_timeout_debit",
    label: "USSD session timeout — customer debited, transfer not completed",
    severity: "critical",
    slaHours: 24,
    sources: ["ussd", "nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "CBN E-Payment Guidelines: USSD transactions that timeout must be reversed within 24 hours. USSD sessions have a 180-second timeout. If the session drops after CBS debit but before NIP instruction is sent, the customer is debited without the transfer being initiated. Telco USSD gateway reliability directly impacts transaction success rates.",
    recommendedResolution:
      "1) Check if the NIP instruction was actually sent despite the USSD session timeout. 2) If NIP was sent: follow standard NIP resolution (TSQ, etc.). 3) If NIP was NOT sent (session died before instruction): reverse the CBS debit immediately. 4) SMS customer confirming reversal. 5) Log the timeout for USSD gateway reliability monitoring. 6) If pattern of timeouts from specific telco, escalate to telco relationship manager.",
    aiDiagnosisHint:
      "CBS debit from USSD channel with no corresponding NIP session_id — the USSD session likely timed out between debit and NIP initiation. Check the USSD session log: if session ended with timeout status and no NIP call was made, it's a clean reversal case. If NIP was called but response wasn't received, follow NIP timeout path.",
  },
  {
    key: "ussd_session_hijack_dispute",
    label: "USSD transaction disputed — possible session manipulation",
    severity: "high",
    slaHours: 48,
    sources: ["ussd", "cbs_ledger"],
    regulatoryContext:
      "CBN Cybersecurity Guidelines: USSD is vulnerable to SIM swap fraud and session manipulation. If a customer disputes a USSD transaction they claim not to have initiated, it may indicate SIM swap (fraudster took over the phone number) or social engineering. CBN requires banks to have SIM swap detection mechanisms.",
    recommendedResolution:
      "1) Verify the transaction details: originating phone number, time, amount, beneficiary. 2) Check if there was a recent SIM swap on the customer's registered phone number (query telco). 3) If SIM swap confirmed within 24-72 hours before the transaction: treat as fraud, reverse if possible, block the channel. 4) If no SIM swap: investigate further — check if customer's PIN could have been compromised. 5) Report to CBN as a fraud incident per reporting requirements. 6) Place temporary hold on USSD channel for the customer pending investigation.",
    aiDiagnosisHint:
      "Customer disputes USSD transaction — first check for SIM swap indicators: was there a SIM change on the registered number within 72 hours? If yes, high probability of fraud. If no SIM swap, check transaction patterns: is the beneficiary known to the customer? Was the transaction amount unusual? USSD fraud typically targets the full available balance.",
  },
  {
    key: "mobile_app_transaction_not_posted",
    label: "Mobile app shows success but transaction not posted to CBS",
    severity: "high",
    slaHours: 24,
    sources: ["mobile_banking", "cbs_ledger"],
    regulatoryContext:
      "CBN E-Payment Guidelines: Mobile banking apps must accurately reflect transaction status. If the app shows 'successful' but the transaction is not posted in CBS, it indicates a disconnect between the app's response handling and the actual backend processing. Customer relies on app confirmation as proof of payment.",
    recommendedResolution:
      "1) Check the mobile banking middleware/API logs for the transaction. 2) Determine where the disconnect occurred: did the backend process the transaction? Did the app receive a false-positive response? 3) If backend processed successfully but CBS posting failed: investigate CBS posting queue and re-post. 4) If backend did NOT process but app showed success: this is a critical app bug — the app's response handling is incorrect. 5) Contact customer to clarify actual status. 6) If transaction genuinely failed, the app needs a correction notification to the customer.",
    aiDiagnosisHint:
      "Customer has app screenshot showing 'successful' but CBS has no record — check middleware logs. If middleware shows the transaction was submitted to NIP and got a success response, the CBS posting failed (re-post needed). If middleware shows the transaction failed but the app displayed success anyway, it's an app-level bug in response code mapping.",
  },
  {
    key: "agent_banking_float_reconciliation",
    label: "Agent banking float account reconciliation break",
    severity: "high",
    slaHours: 24,
    sources: ["agent_banking", "cbs_ledger"],
    regulatoryContext:
      "CBN Agent Banking Guidelines (2013, revised): Agents operate float accounts (also called e-wallet or agent wallet) funded by the super-agent or bank. All agent transactions (cash-in, cash-out, transfers) debit/credit this float account. Reconciliation breaks between the agent's physical cash and float account balance indicate either: unrecorded transactions, fraud, or system errors.",
    recommendedResolution:
      "1) Compare agent float account balance (CBS) against expected balance (opening + deposits − withdrawals per transaction log). 2) If float > expected: agent collected cash but didn't process the transaction (customer complaint likely incoming). 3) If float < expected: transactions processed without corresponding cash collection (agent loss or fraud). 4) Pull full transaction log for the agent for the period and match against float movements. 5) If discrepancy is >₦50,000 or >3 days old, flag for agent audit.",
    aiDiagnosisHint:
      "Agent float account balance ≠ expected based on transaction log — direction indicates the problem: surplus float = missed transactions (cash collected, not processed), deficit float = phantom transactions (processed without cash). Check for reversed transactions that restored float but customer already received cash.",
  },
  {
    key: "agent_cash_in_not_credited",
    label: "Agent cash-in — customer deposited but account not credited",
    severity: "critical",
    slaHours: 24,
    sources: ["agent_banking", "nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "CBN Agent Banking Guidelines: Cash-in transactions must credit the customer's account in real-time (via NIP for interbank or direct posting for on-us). If the customer gives cash to the agent but their account is not credited, the agent's float should have been debited (proving the transaction was initiated). If float was not debited, the agent may not have processed the transaction.",
    recommendedResolution:
      "1) Check if the agent's float account was debited for the transaction. 2) If float debited: the transaction was initiated — trace the NIP leg (for interbank) or CBS posting (for on-us). Follow NIP/CBS exception resolution as applicable. 3) If float NOT debited: the agent collected cash but didn't process the transaction. This is agent fraud/negligence. 4) Contact the agent for explanation. 5) If agent confirms collection, process the transaction manually. 6) If agent denies, escalate to super-agent with evidence (customer receipt if available).",
    aiDiagnosisHint:
      "Customer claims cash deposit at agent but account not credited — check agent float first. Float debited = transaction was initiated (trace the credit leg). Float not debited = agent didn't process it (agent issue, not system issue). If customer has an agent receipt/SMS, that's evidence the agent acknowledged the deposit.",
  },
  {
    key: "agent_cash_out_reversal",
    label: "Agent cash-out reversed after cash given to customer",
    severity: "critical",
    slaHours: 24,
    sources: ["agent_banking", "cbs_ledger"],
    regulatoryContext:
      "CBN Agent Banking Guidelines: Cash-out (withdrawal) transactions debit the customer and credit the agent's float. If the transaction is subsequently reversed (timeout reversal, duplicate reversal, or fraud), the agent has given out cash but their float is restored to pre-transaction level — the agent bears the loss unless recovered.",
    recommendedResolution:
      "1) Identify the reversed cash-out transaction and the reason for reversal. 2) If reversal was system-initiated (timeout auto-reversal): check if cash was actually dispensed to customer. 3) If cash was given and reversal was erroneous: re-debit the customer account and re-credit agent float. 4) If reversal was fraud (customer initiated reversal after receiving cash): block customer, report to police, compensate agent. 5) Agent must report within 24 hours of discovering the discrepancy.",
    aiDiagnosisHint:
      "Agent float credited (reversal) for a transaction where cash was already given to customer — the agent is now short. Check reversal reason: auto-reversal due to timeout (system issue, fixable) vs customer-initiated dispute reversal (potential fraud). If the original transaction shows 'timeout' but cash was given, the auto-reversal was premature.",
  },
  {
    key: "mobile_duplicate_transfer",
    label: "Mobile/USSD duplicate transfer — app retry or double-tap",
    severity: "high",
    slaHours: 24,
    sources: ["mobile_banking", "ussd", "nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "CBN Consumer Protection Regulations: Mobile app and USSD double-submissions are common due to: app retry on timeout, customer tapping 'send' twice, or USSD session replay. Each channel must implement idempotency controls. Duplicate transfers must be reversed within 24 hours of identification.",
    recommendedResolution:
      "1) Identify potential duplicate: same sender + same beneficiary + same amount + timestamps within 60 seconds. 2) Check if the channel has idempotency controls (transaction reference uniqueness). 3) If same transaction reference submitted twice: only one should have processed (idempotency working). 4) If different references but clearly duplicate intent: verify with customer before reversing. 5) If confirmed duplicate, reverse the second transaction. 6) Improve channel UX: disable submit button after first tap, show processing indicator.",
    aiDiagnosisHint:
      "Two identical transfers within 60 seconds from same mobile/USSD session — high probability of duplicate. Check session logs: if same session produced two requests, it's a retry/double-tap. If different sessions, customer may have intentionally sent twice (verify before reversing). USSD duplicates often have sequential session IDs.",
  },
];

export const MOBILE_CHANNEL_EXCEPTION_KEYS = MOBILE_CHANNEL_EXCEPTIONS.map((c) => c.key);
