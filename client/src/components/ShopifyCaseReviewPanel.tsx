import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SHOPIFY_CASE_MAX_PAGE, SHOPIFY_CASE_STATUSES, type ShopifyCase, type ShopifyCaseStatusFilter } from "@shared/shopifyAppHomeCases";
import type { ShopifyCaseReview, ShopifyCaseReviewState } from "@/lib/shopifyCaseReview";

const categoryCopy: Record<ShopifyCase["category"], string> = {
  missing_counterparty: "Counterpart evidence is missing.", amount_mismatch: "Recorded amounts do not agree.",
  timing_difference: "Evidence dates do not agree within the expected window.", duplicate_transaction: "Possible duplicate evidence was identified.",
  unmatched: "No matching counterpart evidence was identified.", reversal_unmatched: "Reversal or refund evidence has no matching counterpart.",
  currency_mismatch: "Recorded currencies do not agree.", fx_rate_variance: "The implied exchange rate differs.", format_error: "Evidence format needs attention.",
};
const label = (value: string) => value.replaceAll("_", " ");
const timestamp = (value: string) => new Date(value).toLocaleString();

export function ShopifyCaseReviewPanel({ state, review }: { state: ShopifyCaseReviewState; review: ShopifyCaseReview }) {
  return <Card className="border-slate-200 shadow-sm">
    <CardHeader>
      <CardTitle className="text-xl text-[#1B365D]">3. Inspect payment exceptions inside Shopify Admin</CardTitle>
      <CardDescription>Read-only case inspection. Decisions, approvals and closure are not editable here. Amounts are the primary evidence leg, not a confirmed loss or difference.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => void review.refresh()}>Refresh cases</Button>
        <Select value={state.status} onValueChange={value => void review.filter(value as ShopifyCaseStatusFilter)}>
          <SelectTrigger aria-label="Case status" className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>{SHOPIFY_CASE_STATUSES.map(status => <SelectItem key={status} value={status}>{label(status)}</SelectItem>)}</SelectContent>
        </Select>
        <p className="text-xs text-slate-500">All evidence dates · unresolved by default</p>
      </div>
      {state.error ? <p role="alert" className="text-sm text-amber-800">{state.error}</p> : null}
      {state.listLoading ? <p role="status">Loading cases… Previous results are not shown as current.</p> : null}
      {state.selected !== null ? <div className="space-y-3 rounded-lg border border-slate-200 p-4">
        <Button variant="outline" onClick={review.back}>Back to cases</Button>
        {state.detailLoading ? <p role="status">Loading case…</p> : null}
        {state.detail ? <>
          <h3 className="font-semibold">Case {state.detail.caseId} · {label(state.detail.category)}</h3>
          <p className="text-sm">{categoryCopy[state.detail.category]}</p>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt>Status</dt><dd>{label(state.detail.status)}</dd></div>
            <div><dt>Severity</dt><dd>{state.detail.severity}</dd></div>
            <div><dt>Primary-leg amount</dt><dd>{state.detail.amount} {state.detail.currency}</dd></div>
            <div><dt>Evidence source</dt><dd>{label(state.detail.sourceKind)}</dd></div>
            <div><dt>Created</dt><dd>{timestamp(state.detail.createdAt)}</dd></div>
            <div><dt>Evidence date</dt><dd>{timestamp(state.detail.evidenceDate)}</dd></div>
          </dl>
        </> : null}
      </div> : state.list ? <>
        <p className="text-sm">{state.list.total} case(s) in this store · page {state.list.page}</p>
        {state.list.cases.length === 0 ? <p className="text-sm text-slate-600">No cases on this page for the selected status.</p> : <ul className="space-y-2">
          {state.list.cases.map(row => <li key={row.caseId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
            <div><p className="font-semibold">{label(row.category)} · {row.severity} · {label(row.status)}</p>
              <p>{row.amount} {row.currency} · primary leg · {label(row.sourceKind)}</p>
              <p className="text-xs text-slate-500">Created {timestamp(row.createdAt)} · evidence {timestamp(row.evidenceDate)}</p>
            </div>
            <Button variant="outline" onClick={() => void review.select(row.caseId)}>Inspect case {row.caseId}</Button>
          </li>)}
        </ul>}
        <div className="flex gap-3">
          <Button variant="outline" disabled={state.page <= 1} onClick={() => void review.page(state.page - 1)}>Previous page</Button>
          <Button variant="outline" disabled={state.page >= SHOPIFY_CASE_MAX_PAGE || state.page * state.list.pageSize >= state.list.total} onClick={() => void review.page(state.page + 1)}>Next page</Button>
        </div>
        {state.page === SHOPIFY_CASE_MAX_PAGE && state.list.total > state.page * state.list.pageSize ? <p className="text-xs">This bounded view ends here. Narrow the status filter to inspect more cases.</p> : null}
      </> : null}
    </CardContent>
  </Card>;
}
