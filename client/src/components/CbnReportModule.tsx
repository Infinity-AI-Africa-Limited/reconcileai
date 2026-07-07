import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
  FileSpreadsheet, Download, Loader2, Building2, ShieldCheck, CheckCircle2,
  AlertTriangle, CalendarDays, History, FileSignature,
} from "lucide-react";

/**
 * CBN Compliance Report Module — standalone, configurable, available to every
 * organisation. Generates the five reports CBN's MFB / commercial-bank
 * supervision departments expect, from the org's own reconciliation data, with
 * one-click CBN-format CSV export. Mounted as the "Regulatory Reports" tab.
 */

type ReportType =
  | "daily_recon_summary" | "exception_log" | "counterparty_exposure" | "interbank_settlement"
  | "mfb_unreconciled_aging";

const REPORTS: { type: ReportType; title: string; desc: string; period: "day" | "range" }[] = [
  { type: "daily_recon_summary", title: "Daily Reconciliation Summary", desc: "Per-channel reconciliation position for a single day — the CBN daily attestation that reconciliation was performed.", period: "day" },
  { type: "exception_log", title: "Exception Log & Resolution Register", desc: "Every exception with resolution status, days outstanding, CBS reflection, and audit-trail event count.", period: "range" },
  { type: "counterparty_exposure", title: "Counterparty Exposure Report", desc: "Open unreconciled exposure aggregated by counterparty, with concentration-risk rating.", period: "range" },
  { type: "interbank_settlement", title: "Interbank Settlement Reconciliation (NIBSS)", desc: "NIBSS / RTGS / SWIFT settlement reconciliation — volume, value, matched value and variance.", period: "range" },
  { type: "mfb_unreconciled_aging", title: "Unreconciled Items Aging Schedule (MFB)", desc: "Unreconciled items aged 0–30 / 31–60 / 61–90 / 90+ days per channel, with provisioning flags — the MFB examination and OFISD monthly-return staple.", period: "day" },
];

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const monthStr = () => new Date().toISOString().slice(0, 7);

// ─── Institution profile ──────────────────────────────────────────────────────
function InstitutionProfile() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.cbnCompliance.getReportSettings.useQuery();
  const [form, setForm] = useState<Record<string, string>>({});
  const save = trpc.cbnCompliance.saveReportSettings.useMutation({
    onSuccess: () => { utils.cbnCompliance.getReportSettings.invalidate(); toast.success("Institution profile saved"); },
    onError: (e) => toast.error(e.message || "Save failed"),
  });
  const val = (k: string) => form[k] ?? (data as any)?.[k] ?? "";
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  if (isLoading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Building2 className="h-4 w-4 text-primary" /> Institution Profile</CardTitle>
        <CardDescription>Appears in the header of every report and the monthly attestation. Set this once.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid md:grid-cols-2 gap-4">
          <div><Label className="text-xs">Institution name</Label><Input value={val("institutionName")} onChange={(e) => set("institutionName", e.target.value)} placeholder="e.g. LAPO Microfinance Bank" /></div>
          <div>
            <Label className="text-xs">Institution type</Label>
            <Select value={val("institutionType") || "microfinance_bank"} onValueChange={(v) => set("institutionType", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="microfinance_bank">Microfinance Bank (MFB)</SelectItem>
                <SelectItem value="commercial_bank">Commercial Bank</SelectItem>
                <SelectItem value="payment_service_bank">Payment Service Bank (PSB)</SelectItem>
                <SelectItem value="merchant_bank">Merchant Bank</SelectItem>
                <SelectItem value="other_financial_institution">Other Financial Institution (OFI)</SelectItem>
                <SelectItem value="fintech">Fintech / PSP</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label className="text-xs">RC number (CAC)</Label><Input value={val("rcNumber")} onChange={(e) => set("rcNumber", e.target.value)} /></div>
          <div><Label className="text-xs">CBN licence number</Label><Input value={val("cbnLicenseNumber")} onChange={(e) => set("cbnLicenseNumber", e.target.value)} /></div>
          <div><Label className="text-xs">CBN / NIBSS institution code</Label><Input value={val("cbnInstitutionCode")} onChange={(e) => set("cbnInstitutionCode", e.target.value)} /></div>
          <div><Label className="text-xs">Compliance contact email</Label><Input value={val("complianceContactEmail")} onChange={(e) => set("complianceContactEmail", e.target.value)} /></div>
          <div><Label className="text-xs">Prepared by (name)</Label><Input value={val("preparedByName")} onChange={(e) => set("preparedByName", e.target.value)} placeholder="Reconciliation officer" /></div>
          <div><Label className="text-xs">Prepared by (title)</Label><Input value={val("preparedByTitle")} onChange={(e) => set("preparedByTitle", e.target.value)} /></div>
          <div><Label className="text-xs">Attesting officer (name)</Label><Input value={val("attestingOfficerName")} onChange={(e) => set("attestingOfficerName", e.target.value)} placeholder="CFO / Chief Compliance Officer" /></div>
          <div><Label className="text-xs">Attesting officer (title)</Label><Input value={val("attestingOfficerTitle")} onChange={(e) => set("attestingOfficerTitle", e.target.value)} /></div>
        </div>
        <Button onClick={() => save.mutate(form)} disabled={save.isPending} className="gap-2">
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Save profile
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Report preview table ──────────────────────────────────────────────────────
function PreviewTable({ result }: { result: any }) {
  if (!result) return null;
  return (
    <div className="mt-3 space-y-3">
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{result.meta.institutionName}</span> · {result.meta.institutionType} · Period: {result.meta.periodLabel}
        <div className="mt-0.5 italic">{result.meta.regulatoryBasis}</div>
      </div>
      <div className="overflow-x-auto border rounded-lg max-h-80 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/60">
            <tr>{result.columns.map((c: string) => <th key={c} className="text-left px-3 py-2 font-medium whitespace-nowrap">{c}</th>)}</tr>
          </thead>
          <tbody>
            {result.rows.slice(0, 100).map((row: (string | number)[], i: number) => (
              <tr key={i} className="border-t">{row.map((cell, j) => <td key={j} className="px-3 py-1.5 whitespace-nowrap">{String(cell)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
        {Object.entries(result.summary).map(([k, v]) => (
          <span key={k}><span className="text-muted-foreground">{k}:</span> <span className="font-semibold">{String(v)}</span></span>
        ))}
      </div>
      {result.rows.length > 100 && <p className="text-[11px] text-muted-foreground">Showing first 100 of {result.rows.length} rows — the CSV export contains all rows.</p>}
    </div>
  );
}

// ─── Report generator ──────────────────────────────────────────────────────────
function ReportGenerator() {
  const utils = trpc.useUtils();
  const [reportType, setReportType] = useState<ReportType>("daily_recon_summary");
  const [date, setDate] = useState(todayStr());
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); });
  const [to, setTo] = useState(todayStr());
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState<"preview" | "export" | null>(null);

  const spec = REPORTS.find((r) => r.type === reportType)!;
  const params = () => spec.period === "day" ? { reportType, date } : { reportType, from, to };

  const exportCsv = trpc.cbnCompliance.exportReportCsv.useMutation();

  const handlePreview = async () => {
    setBusy("preview"); setPreview(null);
    try {
      const r = await utils.cbnCompliance.generateReport.fetch(params());
      setPreview(r);
      if (!r.rows.length) toast.info("No data for this period");
    } catch (e: any) { toast.error(e.message || "Failed to generate"); }
    finally { setBusy(null); }
  };
  const handleExport = async () => {
    setBusy("export");
    try {
      const r = await exportCsv.mutateAsync(params());
      downloadCsv(r.filename, r.csv);
      toast.success("CBN report exported", { description: `${r.filename} — ${r.rowCount} rows` });
    } catch (e: any) { toast.error(e.message || "Export failed"); }
    finally { setBusy(null); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><FileSpreadsheet className="h-4 w-4 text-primary" /> Regulatory Reports</CardTitle>
        <CardDescription>Generate a CBN-supervision report from your reconciliation data, then export it in CBN CSV format with one click.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Report</Label>
            <Select value={reportType} onValueChange={(v) => { setReportType(v as ReportType); setPreview(null); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{REPORTS.map((r) => <SelectItem key={r.type} value={r.type}>{r.title}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {spec.period === "day" ? (
            <div><Label className="text-xs">Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div><Label className="text-xs">From</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div><Label className="text-xs">To</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{spec.desc}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handlePreview} disabled={busy !== null} className="gap-2">
            {busy === "preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />} Generate preview
          </Button>
          <Button onClick={handleExport} disabled={busy !== null} className="gap-2">
            {busy === "export" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export CBN CSV
          </Button>
        </div>
        {preview && <PreviewTable result={preview} />}
      </CardContent>
    </Card>
  );
}

// ─── Monthly attestation ─────────────────────────────────────────────────────
function MonthlyAttestation() {
  const utils = trpc.useUtils();
  const [month, setMonth] = useState(monthStr());
  const [result, setResult] = useState<any>(null);
  const gen = trpc.cbnCompliance.generateMonthlyAttestation.useMutation({
    onSuccess: (r) => { setResult(r); utils.cbnCompliance.listReportRuns.invalidate(); toast.success("Attestation signed", { description: r.document.overallStatus }); },
    onError: (e) => toast.error(e.message || "Failed"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><FileSignature className="h-4 w-4 text-primary" /> Monthly Compliance Attestation</CardTitle>
        <CardDescription>Generates the monthly reconciliation attestation and digitally signs it (Ed25519) — a tamper-evident artifact for CBN examination.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-2">
          <div><Label className="text-xs">Month</Label><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" /></div>
          <Button onClick={() => gen.mutate({ month })} disabled={gen.isPending} className="gap-2">
            {gen.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSignature className="h-4 w-4" />} Generate &amp; sign
          </Button>
        </div>

        {result && (
          <div className="rounded-lg border p-4 space-y-3 bg-muted/20">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold">{result.document.institution.name}</p>
                <p className="text-xs text-muted-foreground">{result.document.institution.type} · {result.document.monthLabel}</p>
              </div>
              <Badge className={result.document.overallStatus === "COMPLIANT" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}>
                {result.document.overallStatus === "COMPLIANT" ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <AlertTriangle className="h-3 w-3 mr-1" />}
                {result.document.overallStatus}
              </Badge>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              {[
                ["Match rate", `${result.document.metrics.matchRate}%`],
                ["Exception ratio", `${result.document.metrics.exceptionRatio}%`],
                ["Open exceptions", result.document.metrics.openExceptions],
                ["Open exposure (₦)", Number(result.document.metrics.openExposureNGN).toLocaleString("en-NG")],
              ].map(([k, v]) => (
                <div key={k as string} className="rounded-md border bg-white p-2"><p className="text-[11px] text-muted-foreground">{k}</p><p className="font-semibold">{v}</p></div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground italic">{result.document.attestation}</p>
            <div className="rounded-md bg-[#0a0f1e] text-emerald-300 p-3 font-mono text-[10px] break-all">
              <p className="text-white/60 mb-1 flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> Digital signature ({result.signature.algorithm})</p>
              <p>signature: {result.signature.signature}</p>
              <p>hash: {result.signature.contentHash}</p>
              <p>key: {result.signature.signingKeyFingerprint}</p>
              <p>signed: {result.signature.signedAt}</p>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-1.5">Print attestation</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── History ──────────────────────────────────────────────────────────────────
function ReportHistory() {
  const { data } = trpc.cbnCompliance.listReportRuns.useQuery(undefined);
  const runs = data ?? [];
  if (runs.length === 0) return null;
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4 text-primary" /> Generation History</CardTitle></CardHeader>
      <CardContent>
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-xs">
            <thead className="bg-muted/50"><tr>
              <th className="text-left px-3 py-2">Report</th><th className="text-left px-3 py-2">Period</th>
              <th className="text-right px-3 py-2">Rows</th><th className="text-left px-3 py-2">Signed</th>
              <th className="text-left px-3 py-2">By</th><th className="text-left px-3 py-2">When</th>
            </tr></thead>
            <tbody>
              {runs.map((r: any) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-1.5">{String(r.reportType).replace(/_/g, " ")}</td>
                  <td className="px-3 py-1.5">{r.periodLabel}</td>
                  <td className="px-3 py-1.5 text-right">{r.rowCount}</td>
                  <td className="px-3 py-1.5">{r.signature ? <Badge variant="outline" className="border-emerald-300 text-emerald-700 text-[10px]">Signed</Badge> : "—"}</td>
                  <td className="px-3 py-1.5">{r.generatedByName ?? "—"}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{new Date(r.createdAt).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function CbnReportModule() {
  return (
    <div className="space-y-5">
      <ReportGenerator />
      <MonthlyAttestation />
      <InstitutionProfile />
      <ReportHistory />
    </div>
  );
}
