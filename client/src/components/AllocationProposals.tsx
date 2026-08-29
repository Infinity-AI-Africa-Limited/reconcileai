/**
 * Proposed allocations for a reconciliation job — read-only by construction.
 *
 * The Corporate B2B pilot's headline workflow is "distributor receipt to invoice
 * allocation", and gate B4 requires that every non-exact or many-to-many
 * candidate stays PROPOSED until a named human approves it. So this panel shows
 * and explains; it has no approve button and no mutation, and the endpoint
 * behind it is a query that cannot write. The customer posts allocations in
 * their own system.
 *
 * The refusals matter as much as the proposals. Where several different splits
 * fit a receipt equally well, the engine proposes nothing and says why — an
 * arbitrary allocation presented with a confidence score is a fabricated
 * finding, discovered later as two wrong distributor statements. Those are
 * rendered alongside, because "we could not choose" and "we found nothing" call
 * for different work.
 */
import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Info, Layers } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

type Props = { jobId: number };

const MATCH_LABEL: Record<string, string> = {
  one_to_many: "One receipt → several invoices",
  many_to_one: "Several receipts → one invoice",
  many_to_many: "Grouped by invoice reference",
};

export default function AllocationProposals({ jobId }: Props) {
  const [open, setOpen] = useState(false);
  // Only fetched when the panel is opened: the engine walks every unmatched
  // source against every unmatched target, so it is not work to do on every
  // job view.
  const { data, isLoading, error } = trpc.allocations.proposals.useQuery({ jobId }, { enabled: open });

  const money = (n: number, currency = "") =>
    `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold hover:bg-muted/40"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Layers className="h-4 w-4 text-primary" />
        Allocation proposals
        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-700">
          Read-only
        </span>
      </button>

      {open ? (
        <div className="space-y-4 border-t p-3">
          {isLoading ? <p className="text-sm text-muted-foreground">Working out the splits…</p> : null}
          {error ? <p className="text-sm text-destructive">{error.message}</p> : null}

          {data ? (
            <>
              <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  These are <span className="font-semibold">proposals for a named approver</span>, not postings.
                  Nothing here has been written, and this view cannot write. Post approved allocations in your own
                  finance system. Compared {data.pool.sources} unmatched source and {data.pool.targets} unmatched
                  target items.
                  {data.pool.truncated ? (
                    <span className="font-semibold">
                      {" "}Only the first {data.pool.limit} per side were compared, so allocations outside that
                      window are not shown.
                    </span>
                  ) : null}
                </span>
              </div>

              {data.proposals.length === 0 && data.unresolvedAmbiguities.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No allocation across several items fits these unmatched records.
                </p>
              ) : null}

              {data.proposals.map((p, i) => {
                const currency = data.legend[String(p.splitAllocation[0]?.targetId ?? "")]?.currency ?? "";
                return (
                  <div key={`p-${i}`} className="rounded-md border border-emerald-200 bg-emerald-50/50 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      {MATCH_LABEL[p.matchType] ?? p.matchType}
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                        {p.confidenceScore}% confidence
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{p.matchReason}</p>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b bg-muted/40">
                            <th className="px-2 py-1 text-left">Receipt</th>
                            <th className="px-2 py-1 text-left">Invoice</th>
                            <th className="px-2 py-1 text-right">Allocated</th>
                            <th className="px-2 py-1 text-right">Share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.splitAllocation.map((a, j) => (
                            <tr key={j} className="border-b last:border-0">
                              <td className="px-2 py-1 font-mono">{data.legend[String(a.sourceId)]?.reference ?? a.sourceId}</td>
                              <td className="px-2 py-1 font-mono">{a.invoiceRef ?? data.legend[String(a.targetId)]?.reference ?? a.targetId}</td>
                              <td className="px-2 py-1 text-right font-mono">{money(a.allocatedAmount)}</td>
                              <td className="px-2 py-1 text-right">{a.allocationPercent}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {p.amountDifference > 0 ? (
                      <p className="mt-2 text-xs text-amber-800">
                        Unexplained difference of {money(p.amountDifference, currency)}
                        {p.fxVariance ? ` — ${p.fxVariance.explanation}` : ""}. Confirm before approving.
                      </p>
                    ) : null}
                  </div>
                );
              })}

              {data.unresolvedAmbiguities.length > 0 ? (
                <div>
                  <h5 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    Refused — needs the remittance advice ({data.unresolvedAmbiguities.length})
                  </h5>
                  <div className="space-y-2">
                    {data.unresolvedAmbiguities.map((a, i) => (
                      <div key={`a-${i}`} className="rounded-md border border-amber-200 bg-amber-50/60 p-2 text-xs">
                        <div className="font-medium">
                          {a.reason === "ambiguous"
                            ? "More than one split fits equally well"
                            : "Too many combinations to decide"}
                        </div>
                        <p className="mt-0.5 text-muted-foreground">{a.detail}</p>
                        <p className="mt-1 font-mono text-[11px]">
                          {[...a.sourceIds, ...a.targetIds]
                            .map((id) => data.legend[String(id)]?.reference ?? id)
                            .join(" · ")}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {!open ? null : (
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
