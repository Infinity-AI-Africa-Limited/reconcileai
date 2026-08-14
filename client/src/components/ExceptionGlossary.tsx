import { useState } from "react";
import { useOrgSegment } from "@/hooks/useOrgSegment";
import { isCorporateB2B } from "@/lib/segments";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { BookOpen, ChevronDown } from "lucide-react";

/**
 * Reconciliation Exception Glossary — plain-English reference for the kinds of
 * discrepancies an analyst encounters. Grouped so the most important set (the
 * categories ReconcileAI auto-classifies) is first, followed by domain sets that
 * recur in African bank / MFB / FMCG reconciliation.
 */
type GlossaryEntry = { term: string; description: string };
// hideForCorporateB2b: card-settlement terms are finserv-specific, so they're
// hidden in the Corporate B2B segment (and when a super admin views as one).
type GlossaryGroup = { title: string; note?: string; hideForCorporateB2b?: boolean; entries: GlossaryEntry[] };

const GLOSSARY: GlossaryGroup[] = [
  {
    title: "Core reconciliation exceptions",
    note: "The categories ReconcileAI automatically detects and classifies on every job.",
    entries: [
      { term: "Unmatched", description: "A transaction in one source with no corresponding entry in the other. Confirm it posted to the counterparty system, or escalate to the originating channel." },
      { term: "Missing counterparty", description: "The transaction has no identifiable counterparty, or the name doesn't match a known party. Confirm identity in the registry and add an alias to prevent recurrence." },
      { term: "Amount mismatch", description: "A matching reference was found but the amounts differ. Check for fees, charges, FX, or a keying error." },
      { term: "Timing difference", description: "The same transaction posted on different dates across sources (settlement lag). Usually clears in the next cycle — match on value date." },
      { term: "Duplicate transaction", description: "The same transaction appears more than once. Confirm whether it's a genuine repost and reverse the duplicate, keeping the original." },
      { term: "Unmatched reversal", description: "A reversal with no matching original transaction. Locate and link the original (possibly in a prior period), or post the offsetting entry." },
      { term: "Currency mismatch", description: "The transaction currencies differ between sources. Apply the agreed FX rate for the value date and post any FX difference to the revaluation account." },
      { term: "Format error", description: "The row couldn't be parsed cleanly — a malformed date, amount, or reference. Re-export from the source in the expected format and re-run." },
    ],
  },
  {
    title: "Card & settlement exceptions",
    hideForCorporateB2b: true,
    note: "Common when reconciling a core banking ledger against a card processor / scheme settlement file (e.g. Interswitch, Visa, Mastercard, Verve).",
    entries: [
      { term: "Chargeback", description: "The customer or issuer has disputed a transaction. The ledger shows a debit reversal the settlement file has not yet reflected." },
      { term: "Settlement shortfall", description: "The processor settled less than the posted amount — typically due to interchange or scheme-fee deductions." },
      { term: "Late presentment", description: "The transaction date is outside the processor's settlement window (e.g. >3 days). May incur late-presentment fees." },
      { term: "Interchange fee dispute", description: "The interchange fee applied doesn't match the expected rate for the card type / merchant category." },
      { term: "Scheme fee variance", description: "The card-scheme fee (Visa / Mastercard / Verve) differs from the contracted rate." },
      { term: "Force-post / offline txn", description: "An offline or force-posted transaction approved without authorisation. Higher chargeback risk." },
      { term: "Partial reversal", description: "Only part of the original transaction was reversed. Ensure the net amount is correctly reflected in the ledger." },
      { term: "In ledger, not in settlement", description: "The ledger posted a card credit the processor has not included in the settlement file." },
      { term: "In settlement, not in ledger", description: "The processor settled an amount the ledger has no matching posting for." },
      { term: "Duplicate RRN", description: "The same retrieval reference number (RRN) appears more than once in the settlement file — only one should settle." },
      { term: "Reversal / net-off", description: "A reversal pair was found. Confirm both legs are recorded and net to zero." },
    ],
  },
  {
    title: "General settlement & GL reconciliation",
    note: "Broader discrepancies that arise across channels, GL-to-CBS, and corporate / FMCG reconciliation.",
    entries: [
      { term: "Suspense / unallocated", description: "Funds received but not yet matched to a customer, invoice, or GL account — sitting in suspense pending allocation." },
      { term: "Split settlement", description: "A single transaction settled across multiple lines (or batched), so amounts don't tie one-to-one. Aggregate before matching." },
      { term: "Misposting / wrong account", description: "A valid transaction posted to the wrong GL account, product, or customer. Reclassify to the correct account." },
      { term: "Fee / commission variance", description: "A bank charge, commission, or VAT deduction explains the gross-vs-net difference between the two sources." },
      { term: "Rounding difference", description: "A sub-unit (kobo) rounding difference within tolerance. Auto-approve and note the reason." },
      { term: "Stale / unsettled item", description: "A transaction authorised but never settled (or vice versa) beyond the expected window. Investigate with the channel." },
      { term: "FX revaluation difference", description: "A cross-currency entry whose variance is due to a different FX rate than the booking rate. Post the difference to the revaluation account." },
      { term: "Failed but posted", description: "A declined or failed transaction that nonetheless hit the ledger. Reverse the erroneous posting." },
      { term: "Refund without original", description: "A refund or credit with no matching original sale. Verify the original and link, or query the counterparty." },
    ],
  },
];

export default function ExceptionGlossary({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  // Effective segment: a super admin viewing-as an org uses that org's segment;
  // otherwise the caller's own org segment. Card-settlement terms are hidden for
  // Corporate B2B; any other / unknown segment shows the full glossary.
  // Shared derivation — see hooks/useOrgSegment. Previously inlined here; the
  // dashboard and its view switcher now need the same answer, and three copies
  // is how one of them silently drifts.
  const segment = useOrgSegment();
  const hidesCardSettlementTerms = isCorporateB2B(segment);
  const groups = GLOSSARY.filter((g) => !(g.hideForCorporateB2b && hidesCardSettlementTerms));

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between px-6 py-4 text-left">
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <BookOpen className="h-4 w-4 text-primary" />
            Exception Glossary
            <span className="font-normal text-muted-foreground">— what each exception type means</span>
          </span>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 space-y-6">
            {groups.map((group) => (
              <div key={group.title}>
                <p className="text-xs font-semibold text-foreground">{group.title}</p>
                {group.note && <p className="text-[11px] text-muted-foreground mt-0.5 mb-2">{group.note}</p>}
                <div className="grid md:grid-cols-2 gap-x-6 gap-y-2">
                  {group.entries.map((e) => (
                    <div key={e.term} className="flex gap-2">
                      <Badge variant="outline" className="shrink-0 text-[10px] self-start mt-0.5">
                        {e.term}
                      </Badge>
                      <p className="text-xs text-muted-foreground">{e.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
