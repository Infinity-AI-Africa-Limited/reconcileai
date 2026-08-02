/**
 * Settlement-file importer — reconcile against any payment system.
 *
 * Merchants not on SHOPLINE Payments (third-party gateway, or Cash on Delivery)
 * have an order book with no payment leg. This lets them drop in the gateway's
 * or courier's own CSV/XLSX export to complete the reconciliation.
 *
 * Two-step by design: the file is first sent with `dryRun` so the merchant can
 * SEE which column was read as the order reference before anything is written.
 * Auto-detection is good, not infallible, and silently importing against the
 * wrong column would produce a file that imports cleanly and matches nothing.
 */
import { useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

const SPREADSHEET_RE = /\.(xlsx|xlsm|xls)$/i;
const MAX_BYTES = 10 * 1024 * 1024;

/** Field → what to call it for a non-technical merchant. */
const FIELD_LABELS: Record<string, string> = {
  orderRef: "Order reference (match key)",
  gatewayRef: "Gateway transaction ID",
  amount: "Settled amount",
  currency: "Currency",
  settledAt: "Settlement date",
  fee: "Fee",
  description: "Description",
};

type Preview = {
  committed: boolean;
  headers: string[];
  mapping: Record<string, string>;
  missingRequired: string[];
  totalRows: number;
  parseErrors: string[];
  sampleRows?: Record<string, string>[];
};

async function readFile(file: File): Promise<{ content: string; encoding: "utf8" | "base64" }> {
  if (SPREADSHEET_RE.test(file.name)) {
    const buf = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000; // chunked: spreading a whole file blows the arg limit
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return { content: btoa(binary), encoding: "base64" };
  }
  return { content: await file.text(), encoding: "utf8" };
}

export function SettlementFileImport({ onImported }: { onImported?: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const importFile = trpc.shoplineConnector.importSettlementFile.useMutation();

  const run = async (dryRun: boolean) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast.error(`File is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is 10MB. Split it by date range.`);
      return;
    }
    setBusy(true);
    try {
      const { content, encoding } = await readFile(file);
      const res = await importFile.mutateAsync({
        fileName: file.name,
        content,
        contentEncoding: encoding,
        sourceLabel: sourceLabel.trim() || file.name,
        dryRun,
      });
      setPreview(res as Preview);
      if (!dryRun && res.committed) {
        const r = res as { imported: number; duplicates: number; failed: number; matchedCount: number };
        toast.success(
          `Imported ${r.imported} settlement rows — ${r.matchedCount} matched to orders` +
            (r.duplicates ? `, ${r.duplicates} already present` : "") +
            (r.failed ? `, ${r.failed} rejected` : ""),
        );
        onImported?.();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const mapped = preview ? Object.entries(preview.mapping) : [];
  const canCommit = preview && !preview.committed && preview.missingRequired.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4" />
          Import a settlement file
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Upload the payout or settlement export from your payment provider, bank or courier —
          CSV or Excel. Columns are detected automatically; you confirm the mapping before anything
          is imported.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">File</label>
            <Input
              ref={inputRef}
              type="file"
              accept=".csv,.txt,.xlsx,.xlsm,.xls"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Source (e.g. Stripe, Paystack, DHL COD)
            </label>
            <Input
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              placeholder="Payment provider name"
            />
          </div>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!file || busy} onClick={() => run(true)}>
            {busy && !preview ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
            Check columns
          </Button>
          <Button size="sm" disabled={!canCommit || busy} onClick={() => run(false)}>
            {busy && preview ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Import {preview ? `${preview.totalRows} rows` : ""}
          </Button>
        </div>

        {preview && (
          <div className="rounded-md border p-3 space-y-3">
            {preview.missingRequired.length > 0 ? (
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Could not identify {preview.missingRequired.map((f) => FIELD_LABELS[f] ?? f).join(" and ")}.</p>
                  <p className="text-muted-foreground">
                    The order reference is what links a settlement row to an order — without it
                    nothing can be matched. Columns found:{" "}
                    <span className="font-mono text-xs">{preview.headers.join(", ")}</span>
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                <p>
                  {preview.committed ? "Imported" : "Ready to import"} — {preview.totalRows} rows detected.
                </p>
              </div>
            )}

            <div className="grid gap-1.5 sm:grid-cols-2">
              {mapped.map(([field, header]) => (
                <div key={field} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">{FIELD_LABELS[field] ?? field}</span>
                  <Badge variant={field === "orderRef" ? "default" : "secondary"} className="font-mono">
                    {header}
                  </Badge>
                </div>
              ))}
            </div>

            {preview.parseErrors.length > 0 && (
              <p className="text-xs text-amber-600">{preview.parseErrors.slice(0, 3).join(" · ")}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
