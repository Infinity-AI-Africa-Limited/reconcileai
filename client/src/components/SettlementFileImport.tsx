/**
 * Settlement-file importer — reconcile against any payment system.
 *
 * Merchants not on SHOPLINE Payments (third-party gateway, or Cash on Delivery)
 * have an order book with no payment leg. This lets them drop in the gateway's
 * or courier's own CSV/XLSX export to complete the reconciliation.
 *
 * Check, correct, import. The file is first sent as a dry run so the merchant
 * SEES which column was read as each value, and can correct it: map a header
 * detection did not recognise, or take away a column it read wrongly. Only the
 * mapping the last check confirmed is imported. Auto-detection is good, not
 * infallible, and importing against the wrong column produces a file that
 * imports cleanly and matches nothing.
 *
 * This component renders; useShoplineSettlementImport decides.
 */
import { useRef } from "react";
import { useShoplineSettlementImport } from "@/hooks/useShoplineSettlementImport";
import {
  SHOPLINE_SETTLEMENT_FIELDS,
  SHOPLINE_SETTLEMENT_FIELD_LABELS,
  type ShoplineSettlementField,
} from "@/lib/shoplineSettlementImport";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

/** Radix Select forbids an empty item value, so "no column" needs a sentinel. */
const NOT_IN_FILE = "__reconcileai_not_in_file__";

export function SettlementFileImport({ onImported }: { onImported?: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settlement = useShoplineSettlementImport((result) => {
    toast.success(
      `Imported ${result.imported} settlement rows — ${result.matchedCount} matched to orders` +
        (result.duplicates ? `, ${result.duplicates} already present` : "") +
        (result.failed ? `, ${result.failed} rejected` : ""),
    );
    // Skipped rows that could not be proved duplicates are said out loud.
    if (result.unverifiableDuplicatesNote) toast.warning(result.unverifiableDuplicatesNote);
    onImported?.();
  });
  const { preview, result } = settlement;
  const labelOf = (field: string) => SHOPLINE_SETTLEMENT_FIELD_LABELS[field as ShoplineSettlementField] ?? field;

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
          CSV or Excel. Columns are detected automatically; you confirm or correct the mapping
          before anything is imported.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">File</label>
            <Input
              ref={inputRef}
              type="file"
              accept=".csv,.txt,.xlsx,.xlsm,.xls"
              onChange={(e) => settlement.chooseFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Source (e.g. Stripe, Paystack, DHL COD)
            </label>
            <Input
              value={settlement.sourceLabel}
              onChange={(e) => settlement.setSourceLabel(e.target.value)}
              placeholder="Payment provider name"
            />
          </div>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!settlement.canCheck} onClick={settlement.checkColumns}>
            {settlement.busy === "checking" ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
            {preview ? "Check columns again" : "Check columns"}
          </Button>
          <Button size="sm" disabled={!settlement.canImport} onClick={settlement.importFile}>
            {settlement.busy === "importing" ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Import {preview ? `${preview.totalRows} rows` : ""}
          </Button>
        </div>

        {settlement.error ? <p className="text-sm text-destructive">{settlement.error}</p> : null}

        {preview ? (
          <div className="rounded-md border p-3 space-y-3">
            {result ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                  <p>
                    Imported {result.imported} rows — {result.matchedCount} matched to orders
                    {result.duplicates > 0 ? `, ${result.duplicates} already recorded` : ""}
                    {result.failed > 0 ? `, ${result.failed} rejected` : ""}.
                  </p>
                </div>
                {result.unverifiableDuplicatesNote ? (
                  <div className="flex items-start gap-2 text-amber-700">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <p>{result.unverifiableDuplicatesNote}</p>
                  </div>
                ) : null}
              </div>
            ) : preview.missingRequired.length > 0 ? (
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Choose a column for {preview.missingRequired.map(labelOf).join(" and ")}.</p>
                  <p className="text-muted-foreground">
                    The order reference is what links a settlement row to an order — without it nothing can be matched.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                <p>Ready to import — {preview.totalRows} rows detected.</p>
              </div>
            )}

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Column mapping</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Confirm which column holds each value, map one that was not recognised, or choose “Not in this
                file” for one read wrongly. Required fields must be mapped.
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {SHOPLINE_SETTLEMENT_FIELDS.map(({ field, required }) => (
                  <div key={field} className="space-y-1.5 rounded-md bg-muted/40 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`shopline-map-${field}`} className="text-xs text-muted-foreground">
                        {labelOf(field)}
                      </Label>
                      {required ? <Badge variant="secondary" className="text-[10px]">Required</Badge> : null}
                    </div>
                    <Select
                      value={settlement.columnMapping?.[field] ?? NOT_IN_FILE}
                      disabled={settlement.busy !== null || result !== null}
                      onValueChange={(value) => settlement.changeColumn(field, value === NOT_IN_FILE ? null : value)}
                    >
                      <SelectTrigger id={`shopline-map-${field}`} className="h-8 font-mono text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NOT_IN_FILE}>{required ? "Choose a column" : "Not in this file"}</SelectItem>
                        {preview.headers.map((header, index) =>
                          header ? (
                            <SelectItem key={`${index}:${header}`} value={header} className="font-mono text-xs">
                              {header}
                            </SelectItem>
                          ) : null,
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              {preview.headers.length === 0 ? (
                <p className="mt-2 text-xs text-amber-600">No column headers were found in this file.</p>
              ) : null}
              {settlement.mappingEdited ? (
                <p className="mt-2 text-xs text-amber-600">
                  You changed the mapping. Check columns again to confirm it before importing.
                </p>
              ) : null}
            </div>

            {preview.parseErrors.length > 0 ? (
              <p className="text-xs text-amber-600">{preview.parseErrors.slice(0, 3).join(" · ")}</p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
