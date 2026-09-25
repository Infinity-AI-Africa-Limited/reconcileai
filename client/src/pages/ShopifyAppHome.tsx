import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Clock3, FileSpreadsheet, LoaderCircle, RefreshCw, ShieldCheck, Sparkles, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  loadShopifyAppHomeContext,
  shopifyAppHomeErrorMessage,
  submitShopifySettlementEvidence,
  triggerShopifyOrderSync,
  type ShopifyAppBridgeContext,
  type ShopifySettlementEvidenceCommitted,
  type ShopifySettlementEvidenceDryRun,
  type ShopifySettlementField,
  type ShopifySyncReport,
} from "@/lib/shopifyAppBridge";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SPREADSHEET_FILE = /\.(xlsx|xlsm|xlsb|xls)$/i;

const FIELD_LABELS: Record<ShopifySettlementField, string> = {
  orderRef: "Order reference (match key)",
  gatewayRef: "Provider transaction reference",
  amount: "Settled amount",
  currency: "Currency",
  settledAt: "Settlement date",
  fee: "Fee",
  description: "Description",
};

async function readSettlementFile(file: File): Promise<{ content: string; contentEncoding: "utf8" | "base64" }> {
  if (!SPREADSHEET_FILE.test(file.name)) {
    return { content: await file.text(), contentEncoding: "utf8" };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return { content: btoa(binary), contentEncoding: "base64" };
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Not yet synced";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

function syncWindow(report: ShopifySyncReport): string {
  const from = new Date(report.window.from);
  const to = new Date(report.window.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "the recent evidence window";
  return `${from.toLocaleString()} – ${to.toLocaleString()}`;
}

export default function ShopifyAppHome() {
  const [context, setContext] = useState<ShopifyAppBridgeContext | null>(null);
  const [syncReport, setSyncReport] = useState<ShopifySyncReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [settlementFile, setSettlementFile] = useState<File | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [settlementBusy, setSettlementBusy] = useState<"checking" | "importing" | null>(null);
  const [settlementPreview, setSettlementPreview] = useState<ShopifySettlementEvidenceDryRun | null>(null);
  const [settlementResult, setSettlementResult] = useState<ShopifySettlementEvidenceCommitted | null>(null);
  const [settlementError, setSettlementError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setContext(await loadShopifyAppHomeContext());
    } catch (err) {
      setError(shopifyAppHomeErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const startSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const report = await triggerShopifyOrderSync();
      setSyncReport(report);
      setContext(await loadShopifyAppHomeContext());
    } catch (err) {
      setError(shopifyAppHomeErrorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  const selectSettlementFile = (file: File | null) => {
    setSettlementFile(file);
    setSettlementPreview(null);
    setSettlementResult(null);
    setSettlementError(null);
  };

  const updateSourceLabel = (value: string) => {
    setSourceLabel(value);
    setSettlementPreview(null);
    setSettlementResult(null);
    setSettlementError(null);
  };

  const submitSettlementFile = async (dryRun: boolean) => {
    if (!settlementFile || !sourceLabel.trim()) return;
    if (settlementFile.size > MAX_FILE_BYTES) {
      setSettlementError("This file is larger than 10MB. Split it by date range, then try again.");
      return;
    }

    setSettlementBusy(dryRun ? "checking" : "importing");
    setSettlementError(null);
    if (dryRun) setSettlementResult(null);
    try {
      const encoded = await readSettlementFile(settlementFile);
      const result = await submitShopifySettlementEvidence({
        fileName: settlementFile.name,
        sourceLabel: sourceLabel.trim(),
        ...encoded,
        dryRun,
      });
      if (result.committed) {
        setSettlementResult(result);
      } else {
        setSettlementPreview(result);
      }
    } catch (err) {
      setSettlementError(shopifyAppHomeErrorMessage(err));
    } finally {
      setSettlementBusy(null);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-50 px-5 py-8 text-slate-950">
        <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <LoaderCircle className="h-5 w-5 animate-spin text-[#F47458]" />
          <p className="text-sm">Verifying your Shopify session and ReconcileAI workspace…</p>
        </div>
      </main>
    );
  }

  if (!context) {
    return (
      <main className="min-h-screen bg-slate-50 px-5 py-8 text-slate-950">
        <Card className="mx-auto max-w-2xl border-amber-200 shadow-sm">
          <CardHeader className="space-y-3">
            <CircleAlert className="h-8 w-8 text-amber-700" />
            <CardTitle className="text-2xl text-[#1B365D]">This Shopify workspace is not ready</CardTitle>
            <CardDescription className="text-base leading-relaxed text-slate-600">
              {error ?? "ReconcileAI could not verify this Shopify session."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="bg-[#1B365D] hover:bg-[#102A43]" onClick={() => void load()}>
              <RefreshCw className="mr-2 h-4 w-4" /> Try again
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const hasPriorSyncIssue = Boolean(context.sync.lastErrorCode);
  return (
    <main className="min-h-screen bg-[#F8F9FA] px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#F47458]">ReconcileAI × Shopify</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-[#1B365D]">Order-evidence workspace</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Compare recent Shopify order evidence with settlement evidence you control, then route any differences through ReconcileAI’s human-approved workflow.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
            <p className="font-semibold text-slate-900">{context.store.displayName}</p>
            <p className="mt-0.5 font-mono text-xs text-slate-500">{context.store.shopDomain}</p>
          </div>
        </header>

        <div className="grid gap-4 md:grid-cols-3">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="space-y-2 pb-4">
              <ShieldCheck className="h-5 w-5 text-[#1B365D]" />
              <CardTitle className="text-base">Read-only Shopify access</CardTitle>
              <CardDescription>ReconcileAI reads minimal recent order evidence only. It cannot edit orders, issue refunds, move money, or change store settings.</CardDescription>
            </CardHeader>
          </Card>
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="space-y-2 pb-4">
              <Clock3 className="h-5 w-5 text-[#1B365D]" />
              <CardTitle className="text-base">Order evidence freshness</CardTitle>
              <CardDescription>{formatTimestamp(context.sync.lastSuccessfulAt)}</CardDescription>
            </CardHeader>
          </Card>
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="space-y-2 pb-4">
              <Sparkles className="h-5 w-5 text-[#1B365D]" />
              <CardTitle className="text-base">Scope A boundary</CardTitle>
              <CardDescription>Shopify Payments settlement, payout and fee data are not connected in this release. You provide the settlement evidence used for reconciliation.</CardDescription>
            </CardHeader>
          </Card>
        </div>

        {error ? (
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
            <p>{error}</p>
          </div>
        ) : null}

        {hasPriorSyncIssue ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            The last order-evidence sync needs attention. Run a new sync below; ReconcileAI will use Shopify’s current record and will not change anything in Shopify.
          </div>
        ) : null}

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl text-[#1B365D]">1. Refresh Shopify order evidence</CardTitle>
            <CardDescription>
              The first controlled sync reads the most recent 24-hour window. Subsequent syncs use a corrective overlap so order updates are rechecked safely.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button className="bg-[#F47458] hover:bg-[#dd5e45]" disabled={syncing} onClick={() => void startSync()}>
              {syncing ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              {syncing ? "Refreshing order evidence…" : "Sync recent Shopify order evidence"}
            </Button>
            {syncReport ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
                <div className="flex gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
                  <div>
                    <p className="font-semibold">Order evidence refreshed</p>
                    <p className="mt-1">
                      {syncReport.inserted} new, {syncReport.updated} updated and {syncReport.unchanged} unchanged record(s) in {syncWindow(syncReport)}.
                    </p>
                  </div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl text-[#1B365D]">2. Add settlement evidence</CardTitle>
            <CardDescription>
              Upload a payout, settlement, payment-provider or courier export you obtained from your provider. ReconcileAI checks the columns before it writes any evidence.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="settlement-file">Settlement export</Label>
                <Input
                  id="settlement-file"
                  type="file"
                  accept=".csv,.txt,.xlsx,.xlsm,.xlsb,.xls"
                  disabled={settlementBusy !== null}
                  onChange={(event) => selectSettlementFile(event.target.files?.[0] ?? null)}
                />
                <p className="text-xs text-slate-500">CSV or Excel, up to 10MB. File contents are never shown in this workspace.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="settlement-source">Evidence source</Label>
                <Input
                  id="settlement-source"
                  value={sourceLabel}
                  maxLength={80}
                  disabled={settlementBusy !== null}
                  placeholder="For example: bank export or courier COD"
                  onChange={(event) => updateSourceLabel(event.target.value)}
                />
                <p className="text-xs text-slate-500">Use a label that identifies where you obtained this merchant-provided evidence.</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                disabled={!settlementFile || !sourceLabel.trim() || settlementBusy !== null}
                onClick={() => void submitSettlementFile(true)}
              >
                {settlementBusy === "checking" ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
                {settlementBusy === "checking" ? "Checking columns…" : "Check columns"}
              </Button>
              <Button
                className="bg-[#1B365D] hover:bg-[#102A43]"
                disabled={!settlementPreview || settlementPreview.missingRequired.length > 0 || settlementBusy !== null || Boolean(settlementResult)}
                onClick={() => void submitSettlementFile(false)}
              >
                {settlementBusy === "importing" ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                {settlementBusy === "importing" ? "Importing evidence…" : `Import${settlementPreview ? ` ${settlementPreview.totalRows} row(s)` : " evidence"}`}
              </Button>
            </div>

            {settlementError ? (
              <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                <p>{settlementError}</p>
              </div>
            ) : null}

            {settlementPreview ? (
              <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start gap-3 text-sm">
                  {settlementPreview.missingRequired.length === 0 ? (
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
                  ) : (
                    <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                  )}
                  <div>
                    <p className="font-semibold text-slate-900">
                      {settlementPreview.missingRequired.length === 0
                        ? `${settlementPreview.totalRows} row(s) are ready for import`
                        : "Required columns are missing"}
                    </p>
                    {settlementPreview.missingRequired.length > 0 ? (
                      <p className="mt-1 text-slate-600">
                        ReconcileAI needs {settlementPreview.missingRequired.map((field) => FIELD_LABELS[field]).join(" and ")}.
                      </p>
                    ) : null}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Detected mapping</p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {(Object.entries(settlementPreview.mapping) as Array<[ShopifySettlementField, string]>).map(([field, header]) => (
                      <div key={field} className="flex items-center justify-between gap-3 rounded-md bg-white px-3 py-2 text-xs">
                        <span className="text-slate-600">{FIELD_LABELS[field]}</span>
                        <Badge variant={field === "orderRef" || field === "amount" ? "default" : "secondary"} className="max-w-[55%] truncate font-mono">
                          {header}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Headers found</p>
                  <p className="mt-1 break-words font-mono text-xs text-slate-700">{settlementPreview.headers.join(", ") || "No headers detected"}</p>
                </div>

                {settlementPreview.parseErrors.length > 0 ? (
                  <p className="text-xs text-amber-700">Some rows have file-structure errors: {settlementPreview.parseErrors.join(" · ")}</p>
                ) : null}
              </div>
            ) : null}

            {settlementResult ? (
              <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
                <div>
                  <p className="font-semibold">Merchant-provided settlement evidence imported</p>
                  <p className="mt-1">
                    {settlementResult.imported} imported, {settlementResult.duplicates} duplicate(s), {settlementResult.failed} failed; {settlementResult.matchedCount} matched and {settlementResult.exceptionCount} exception(s) identified.
                  </p>
                </div>
              </div>
            ) : null}

            <p className="text-xs leading-5 text-slate-500">
              This is merchant-provided evidence. Shopify Payments payouts and fees are not connected or requested, and this import does not change Shopify records.
            </p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl text-[#1B365D]">3. Investigate, approve and evidence</CardTitle>
            <CardDescription>
              Once both sources are present, ReconcileAI identifies differences. A person remains responsible for reviewing and approving every resolution; ReconcileAI never posts a financial decision to Shopify.
            </CardDescription>
          </CardHeader>
        </Card>

        <footer className="pb-4 text-xs leading-5 text-slate-500">
          This embedded workspace uses a fresh Shopify session token for each ReconcileAI request. ReconcileAI processes only the minimum order evidence needed for the stated reconciliation purpose. <a className="font-medium text-[#1B365D] underline underline-offset-2" href="/privacy">Privacy</a> · <a className="font-medium text-[#1B365D] underline underline-offset-2" href="/support">Support</a>
        </footer>
      </div>
    </main>
  );
}
