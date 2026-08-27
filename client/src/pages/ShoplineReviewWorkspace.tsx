import { CheckCircle2, Clock3, Database, LockKeyhole, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { trpc } from "@/lib/trpc";

function dateTime(value: Date | null | undefined) {
  return value ? new Date(value).toLocaleString() : "Not yet recorded";
}

export default function ShoplineReviewWorkspace() {
  const snapshot = trpc.shoplineReview.snapshot.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (snapshot.isLoading) {
    return <main className="min-h-screen bg-slate-50 p-6 text-slate-700">Loading the review workspace…</main>;
  }
  if (snapshot.error || !snapshot.data) {
    return (
      <main className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-xl rounded-2xl border border-rose-200 bg-white p-8 text-center">
          <TriangleAlert className="mx-auto h-9 w-9 text-rose-600" aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold text-slate-950">Review workspace unavailable</h1>
          <p className="mt-2 text-sm text-slate-600">{snapshot.error?.message ?? "Please use the review link supplied in the test instructions."}</p>
        </div>
      </main>
    );
  }

  const { workspace, connection, webhookEvidence, reconciliationEvidence, controlledDataCounts } = snapshot.data;
  const needsAttention = connection.statusDetail.code === "attention";
  const pendingVerification = connection.statusDetail.code === "reauthorized_pending";

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-slate-950 px-6 py-8 text-white">
        <div className="mx-auto max-w-6xl">
          <p className="text-sm font-medium tracking-wide text-cyan-300">SHOPLINE APP REVIEW</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">{workspace.title}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">A constrained evidence view for evaluating the current ReconcileAI Dev Store integration. No account, write controls, merchant credentials, or raw customer/payment records are available here.</p>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-8">
        <section aria-label="Reviewer controls" className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-5"><LockKeyhole className="h-5 w-5 text-slate-700" aria-hidden="true" /><p className="mt-3 text-sm font-medium">No account required</p><p className="mt-1 text-sm text-slate-600">The review link is server-validated and revocable.</p></div>
          <div className="rounded-xl border border-slate-200 bg-white p-5"><ShieldCheck className="h-5 w-5 text-emerald-700" aria-hidden="true" /><p className="mt-3 text-sm font-medium">Read-only evidence</p><p className="mt-1 text-sm text-slate-600">No payment, order, settlement or app configuration can be changed.</p></div>
          <div className="rounded-xl border border-slate-200 bg-white p-5"><Database className="h-5 w-5 text-sky-700" aria-hidden="true" /><p className="mt-3 text-sm font-medium">Controlled data only</p><p className="mt-1 text-sm text-slate-600">{workspace.dataNotice}</p></div>
        </section>

        <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6" aria-labelledby="connection-heading">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><p className="text-sm font-medium text-slate-500">CONNECTION EVIDENCE</p><h2 id="connection-heading" className="mt-1 text-xl font-semibold">SHOPLINE Dev Store: {connection.storeHandle}</h2></div>
            <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium ${needsAttention ? "bg-rose-100 text-rose-800" : pendingVerification ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
              {needsAttention ? <TriangleAlert className="h-4 w-4" aria-hidden="true" /> : pendingVerification ? <Clock3 className="h-4 w-4" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
              {connection.statusDetail.label}
            </span>
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-600">{connection.statusDetail.detail}</p>
          <dl className="mt-6 grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-3">
            <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Connection status</dt><dd className="mt-1 text-sm font-medium capitalize">{connection.status}</dd></div>
            <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Installed</dt><dd className="mt-1 text-sm font-medium">{dateTime(connection.installedAt)}</dd></div>
            <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Last successful sync</dt><dd className="mt-1 text-sm font-medium">{dateTime(connection.lastSyncAt)}</dd></div>
          </dl>
          <div className="mt-5"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Granted read-only scopes</p><p className="mt-2 text-sm text-slate-700">{connection.scopes.length ? connection.scopes.join(", ") : "No scopes recorded"}</p></div>
        </section>

        <section className="mt-8 grid gap-6 lg:grid-cols-2" aria-label="Operational evidence">
          <div className="rounded-2xl border border-slate-200 bg-white p-6"><div className="flex items-center gap-2"><RefreshCw className="h-5 w-5 text-sky-700" aria-hidden="true" /><h2 className="text-lg font-semibold">Webhook evidence</h2></div><div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="Received" value={webhookEvidence.total} /><Metric label="Processed" value={webhookEvidence.processed} /><Metric label="Pending" value={webhookEvidence.pending} /><Metric label="Needs attention" value={webhookEvidence.attention} /></div><p className="mt-5 text-sm text-slate-600">Recent authorised webhook topics: {webhookEvidence.recentTopics.length ? webhookEvidence.recentTopics.map((event) => event.topic).join(", ") : "None recorded"}.</p></div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6"><div className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-700" aria-hidden="true" /><h2 className="text-lg font-semibold">Reconciliation evidence</h2></div>{reconciliationEvidence ? <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3"><Metric label="Source records" value={reconciliationEvidence.sourceCount} /><Metric label="Matched" value={reconciliationEvidence.matchedCount} /><Metric label="Exceptions" value={reconciliationEvidence.exceptionCount} /><Metric label="Unmatched" value={reconciliationEvidence.unmatchedCount} /><Metric label="Latest run" value={reconciliationEvidence.status} /><Metric label="Completed" value={reconciliationEvidence.completedAt ? "Yes" : "No"} /></div> : <p className="mt-5 text-sm text-slate-600">No completed controlled-data settlement run is currently available to display.</p>}<p className="mt-5 text-sm text-slate-600">Controlled-data inventory: {controlledDataCounts.transactions} transactions and {controlledDataCounts.openExceptions} open exceptions.</p></div>
        </section>

        <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6" aria-labelledby="boundary-heading"><h2 id="boundary-heading" className="text-lg font-semibold">Review boundary</h2><p className="mt-3 max-w-4xl text-sm leading-6 text-slate-600">This workspace demonstrates the Tier 1 redirected, read-only reconciliation evidence flow. It does not initiate payments, approve transactions, post to merchant systems, create customer-facing actions, expose a production merchant outcome, or demonstrate the future subscription/billing lifecycle.</p></section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 text-lg font-semibold text-slate-950">{value}</p></div>;
}
