import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Loader2,
  Download,
  Upload,
  Beaker,
  FileSpreadsheet,
  CheckCircle2,
  ArrowRight,
  Sparkles,
  Info,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const CHANNELS = [
  { code: "core_banking", name: "Core Banking System (CBS)" },
  { code: "nibss", name: "NIBSS Instant Payment (NIP)" },
  { code: "pos", name: "POS Terminal" },
  { code: "mobile_money", name: "Mobile Money" },
  { code: "atm", name: "ATM" },
  { code: "bank_transfer", name: "Bank Transfer" },
  { code: "bank_statement", name: "Bank Statement" },
  { code: "agent_banking", name: "Agent Banking" },
  { code: "fintech_api", name: "Fintech API" },
  { code: "card_payments", name: "Card Payments (Generic)" },
  { code: "CARD_MASTERCARD_ISW", name: "Mastercard (Interswitch)" },
  { code: "CARD_VISA_ISW", name: "Visa (Interswitch)" },
  { code: "CARD_VERVE_ISW", name: "Verve (Interswitch)" },
  { code: "ussd", name: "USSD Banking" },
  { code: "neft", name: "NEFT" },
];

export default function SampleDataPage() {
  const [, setLocation] = useLocation();
  const generateMutation = trpc.sampleData.generate.useMutation();
  const uploadMutation = trpc.upload.createBatch.useMutation();

  // Config state
  const [transactionCount, setTransactionCount] = useState(50);
  const [matchRate, setMatchRate] = useState(75);
  const [sourceChannel, setSourceChannel] = useState("nibss");
  const [targetChannel, setTargetChannel] = useState("bank_transfer");
  const [includeAmountMismatches, setIncludeAmountMismatches] = useState(true);
  const [includeTimingDifferences, setIncludeTimingDifferences] = useState(true);
  const [includeMissingCounterparties, setIncludeMissingCounterparties] = useState(true);
  const [includeDuplicates, setIncludeDuplicates] = useState(true);

  // Date range defaults to last 30 days
  const [dateRangeStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [dateRangeEnd] = useState(() => {
    return new Date().toISOString().split("T")[0];
  });

  // Generated data
  const [generatedData, setGeneratedData] = useState<{
    sourceCSV: string;
    targetCSV: string;
    summary: {
      sourceCount: number;
      targetCount: number;
      exactMatches: number;
      amountMismatches: number;
      timingDifferences: number;
      missingCounterparties: number;
      duplicates: number;
      unmatchedSource: number;
      unmatchedTarget: number;
    };
  } | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadComplete, setUploadComplete] = useState(false);

  // Parse CSV for preview
  const sourcePreview = useMemo(() => {
    if (!generatedData) return [];
    const lines = generatedData.sourceCSV.split("\n");
    return lines.slice(1, 6).map((line) => {
      const parts = line.split(",");
      return {
        ref: parts[0] || "",
        date: parts[2] || "",
        amount: parts[3] || "",
        type: parts[4] || "",
        description: parts[6]?.replace(/^"|"$/g, "") || "",
      };
    });
  }, [generatedData]);

  const targetPreview = useMemo(() => {
    if (!generatedData) return [];
    const lines = generatedData.targetCSV.split("\n");
    return lines.slice(1, 6).map((line) => {
      const parts = line.split(",");
      return {
        ref: parts[0] || "",
        date: parts[2] || "",
        amount: parts[3] || "",
        type: parts[4] || "",
        description: parts[6]?.replace(/^"|"$/g, "") || "",
      };
    });
  }, [generatedData]);

  const handleGenerate = async () => {
    try {
      const result = await generateMutation.mutateAsync({
        transactionCount,
        matchRate,
        sourceChannel,
        targetChannel,
        dateRangeStart,
        dateRangeEnd,
        includeAmountMismatches,
        includeTimingDifferences,
        includeMissingCounterparties,
        includeDuplicates,
      });
      setGeneratedData(result);
      setUploadComplete(false);
      toast.success(
        `Generated ${result.summary.sourceCount} source and ${result.summary.targetCount} target transactions`
      );
    } catch (err: any) {
      toast.error(err.message || "Failed to generate sample data");
    }
  };

  const downloadCSV = (csv: string, filename: string) => {
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const parseCSVForUpload = (
    csvText: string
  ): Array<{
    transactionRef?: string;
    externalRef?: string;
    description?: string;
    amount: string;
    currency: string;
    transactionDate: string;
    valueDate?: string;
    debitCredit: "debit" | "credit";
    counterparty?: string;
  }> => {
    const lines = csvText.trim().split("\n");
    if (lines.length < 2) return [];
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const rows: any[] = [];

    for (let i = 1; i < lines.length; i++) {
      // Handle CSV with quoted fields
      const values: string[] = [];
      let current = "";
      let inQuotes = false;
      for (const char of lines[i]) {
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === "," && !inQuotes) {
          values.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
      values.push(current.trim());

      const row: Record<string, string> = {};
      headers.forEach((h, idx) => {
        row[h] = values[idx] || "";
      });

      const amount = row.amount || "";
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum)) continue;

      const dateStr = row.date || "";
      if (!dateStr) continue;

      const typeVal = (row.type || "").toLowerCase();
      const dc: "debit" | "credit" =
        typeVal === "credit" || typeVal === "cr" ? "credit" : "debit";

      rows.push({
        transactionRef: row.reference || "",
        externalRef: row.external_ref || "",
        description: row.description || "",
        amount: String(Math.abs(amountNum)),
        currency: row.currency || "NGN",
        transactionDate: dateStr,
        valueDate: row.value_date || "",
        debitCredit: dc,
        counterparty: row.counterparty || "",
      });
    }
    return rows;
  };

  const handleUploadBoth = async () => {
    if (!generatedData) return;
    setUploading(true);
    try {
      const sourceParsed = parseCSVForUpload(generatedData.sourceCSV);
      const targetParsed = parseCSVForUpload(generatedData.targetCSV);

      const sourceResult = await uploadMutation.mutateAsync({
        channelCode: sourceChannel,
        fileName: `sample_source_${sourceChannel}_${new Date().toISOString().split("T")[0]}.csv`,
        transactions: sourceParsed,
      });

      const targetResult = await uploadMutation.mutateAsync({
        channelCode: targetChannel,
        fileName: `sample_target_${targetChannel}_${new Date().toISOString().split("T")[0]}.csv`,
        transactions: targetParsed,
      });

      setUploadComplete(true);
      toast.success(
        `Uploaded ${sourceResult.validRows} source + ${targetResult.validRows} target transactions`
      );
    } catch (err: any) {
      toast.error(err.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const sourceChannelName =
    CHANNELS.find((c) => c.code === sourceChannel)?.name || sourceChannel;
  const targetChannelName =
    CHANNELS.find((c) => c.code === targetChannel)?.name || targetChannel;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-primary">
          Sample Data Generator
        </h1>
        <p className="text-muted-foreground mt-1">
          Generate realistic Nigerian banking transaction data to test the
          reconciliation engine
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Configuration Panel */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Beaker className="h-5 w-5 text-accent" />
                Configure Sample Data
              </CardTitle>
              <CardDescription>
                Customize the generated transactions to test different
                reconciliation scenarios
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Transaction Count */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">
                    Transaction Count
                  </Label>
                  <span className="text-sm font-mono text-muted-foreground">
                    {transactionCount}
                  </span>
                </div>
                <Slider
                  value={[transactionCount]}
                  onValueChange={([v]) => setTransactionCount(v)}
                  min={10}
                  max={500}
                  step={10}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Number of source transactions to generate (10-500)
                </p>
              </div>

              {/* Match Rate */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">
                    Target Match Rate
                  </Label>
                  <span className="text-sm font-mono text-muted-foreground">
                    {matchRate}%
                  </span>
                </div>
                <Slider
                  value={[matchRate]}
                  onValueChange={([v]) => setMatchRate(v)}
                  min={0}
                  max={100}
                  step={5}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Percentage of transactions that will have a matching
                  counterpart
                </p>
              </div>

              {/* Channel Selection */}
              {(sourceChannel === "core_banking" || targetChannel === "core_banking") && (
                <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  <strong>Core Banking System (CBS)</strong> is the authoritative transaction source. When selected, generated transactions will use CBS reference prefixes (CBS/...) and loan/ledger-specific descriptions, mirroring real core banking postings.
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Source Channel</Label>
                  <Select
                    value={sourceChannel}
                    onValueChange={setSourceChannel}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHANNELS.map((ch) => (
                        <SelectItem key={ch.code} value={ch.code}>
                          {ch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Target Channel</Label>
                  <Select
                    value={targetChannel}
                    onValueChange={setTargetChannel}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHANNELS.map((ch) => (
                        <SelectItem key={ch.code} value={ch.code}>
                          {ch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Date Range */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Date From</Label>
                  <Input type="date" value={dateRangeStart} readOnly />
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Date To</Label>
                  <Input type="date" value={dateRangeEnd} readOnly />
                </div>
              </div>

              {/* Exception Toggles */}
              <div className="space-y-1">
                <Label className="text-sm font-medium">
                  Exception Scenarios
                </Label>
                <p className="text-xs text-muted-foreground mb-3">
                  Include intentional mismatches to test exception handling
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="text-sm font-medium">Amount Mismatches</p>
                      <p className="text-xs text-muted-foreground">
                        0.6-2.5% differences
                      </p>
                    </div>
                    <Switch
                      checked={includeAmountMismatches}
                      onCheckedChange={setIncludeAmountMismatches}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="text-sm font-medium">Timing Differences</p>
                      <p className="text-xs text-muted-foreground">
                        4-9 day gaps
                      </p>
                    </div>
                    <Switch
                      checked={includeTimingDifferences}
                      onCheckedChange={setIncludeTimingDifferences}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="text-sm font-medium">
                        Missing Counterparties
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Empty counterparty fields
                      </p>
                    </div>
                    <Switch
                      checked={includeMissingCounterparties}
                      onCheckedChange={setIncludeMissingCounterparties}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="text-sm font-medium">
                        Duplicate Transactions
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Duplicate entries in target
                      </p>
                    </div>
                    <Switch
                      checked={includeDuplicates}
                      onCheckedChange={setIncludeDuplicates}
                    />
                  </div>
                </div>
              </div>

              {/* Generate Button */}
              <Button
                onClick={handleGenerate}
                disabled={generateMutation.isPending}
                className="w-full"
                size="lg"
              >
                {generateMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />{" "}
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" /> Generate Sample Data
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Info Panel */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Info className="h-4 w-4" />
                How It Works
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-3 text-muted-foreground">
              <p>
                The sample data generator creates two CSV files that simulate
                real Nigerian banking transactions:
              </p>
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  <span className="font-mono text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded mt-0.5">
                    1
                  </span>
                  <span>
                    <strong className="text-foreground">Source file</strong>{" "}
                    contains transactions from the selected source channel
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="font-mono text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded mt-0.5">
                    2
                  </span>
                  <span>
                    <strong className="text-foreground">Target file</strong>{" "}
                    contains matching (and non-matching) transactions from the
                    target channel
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="font-mono text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded mt-0.5">
                    3
                  </span>
                  <span>
                    Upload both files, then run reconciliation to see the AI
                    matching engine in action
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Generated Data Includes</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2 text-muted-foreground">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span>Realistic Nigerian bank names</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span>Nigerian personal names</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span>NGN currency amounts (500 - 5M)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span>Channel-specific reference formats</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span>Configurable exception scenarios</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span>Debit/credit transaction mix</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Generated Data Results */}
      {generatedData && (
        <div className="space-y-4">
          {/* Summary */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                Sample Data Generated
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-4">
                <div className="text-center p-3 rounded-lg bg-primary/5">
                  <p className="text-2xl font-bold text-primary">
                    {generatedData.summary.sourceCount}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Source Transactions
                  </p>
                </div>
                <div className="text-center p-3 rounded-lg bg-primary/5">
                  <p className="text-2xl font-bold text-primary">
                    {generatedData.summary.targetCount}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Target Transactions
                  </p>
                </div>
                <div className="text-center p-3 rounded-lg bg-green-50">
                  <p className="text-2xl font-bold text-green-600">
                    {generatedData.summary.exactMatches}
                  </p>
                  <p className="text-xs text-muted-foreground">Exact Matches</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-amber-50">
                  <p className="text-2xl font-bold text-amber-600">
                    {generatedData.summary.amountMismatches +
                      generatedData.summary.timingDifferences +
                      generatedData.summary.duplicates}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Near Matches / Exceptions
                  </p>
                </div>
                <div className="text-center p-3 rounded-lg bg-red-50">
                  <p className="text-2xl font-bold text-red-600">
                    {generatedData.summary.unmatchedSource}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Unmatched Source
                  </p>
                </div>
              </div>

              {/* Breakdown */}
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <div className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  Amount mismatches: {generatedData.summary.amountMismatches}
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                  Timing differences: {generatedData.summary.timingDifferences}
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <div className="h-1.5 w-1.5 rounded-full bg-purple-500" />
                  Missing counterparties:{" "}
                  {generatedData.summary.missingCounterparties}
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <div className="h-1.5 w-1.5 rounded-full bg-red-500" />
                  Duplicates: {generatedData.summary.duplicates}
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <div className="h-1.5 w-1.5 rounded-full bg-gray-500" />
                  Unmatched target: {generatedData.summary.unmatchedTarget}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Preview Tables */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Source Preview */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-primary" />
                    Source: {sourceChannelName}
                  </CardTitle>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      downloadCSV(
                        generatedData.sourceCSV,
                        `sample_source_${sourceChannel}.csv`
                      )
                    }
                  >
                    <Download className="h-3.5 w-3.5 mr-1" /> Download
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="text-left py-2 px-2">Reference</th>
                        <th className="text-left py-2 px-2">Date</th>
                        <th className="text-right py-2 px-2">Amount</th>
                        <th className="text-left py-2 px-2">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sourcePreview.map((row, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-1.5 px-2 font-mono text-[11px] max-w-[120px] truncate">
                            {row.ref}
                          </td>
                          <td className="py-1.5 px-2">{row.date}</td>
                          <td className="py-1.5 px-2 text-right font-mono">
                            {parseFloat(row.amount).toLocaleString()}
                          </td>
                          <td className="py-1.5 px-2">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                row.type === "credit"
                                  ? "bg-green-100 text-green-700"
                                  : "bg-red-100 text-red-700"
                              }`}
                            >
                              {row.type.toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="text-xs text-muted-foreground text-center py-1.5">
                    Showing 5 of {generatedData.summary.sourceCount} rows
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Target Preview */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-accent" />
                    Target: {targetChannelName}
                  </CardTitle>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      downloadCSV(
                        generatedData.targetCSV,
                        `sample_target_${targetChannel}.csv`
                      )
                    }
                  >
                    <Download className="h-3.5 w-3.5 mr-1" /> Download
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="text-left py-2 px-2">Reference</th>
                        <th className="text-left py-2 px-2">Date</th>
                        <th className="text-right py-2 px-2">Amount</th>
                        <th className="text-left py-2 px-2">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {targetPreview.map((row, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-1.5 px-2 font-mono text-[11px] max-w-[120px] truncate">
                            {row.ref}
                          </td>
                          <td className="py-1.5 px-2">{row.date}</td>
                          <td className="py-1.5 px-2 text-right font-mono">
                            {parseFloat(row.amount).toLocaleString()}
                          </td>
                          <td className="py-1.5 px-2">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                row.type === "credit"
                                  ? "bg-green-100 text-green-700"
                                  : "bg-red-100 text-red-700"
                              }`}
                            >
                              {row.type.toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="text-xs text-muted-foreground text-center py-1.5">
                    Showing 5 of {generatedData.summary.targetCount} rows
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Action Buttons */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  onClick={handleUploadBoth}
                  disabled={uploading || uploadComplete}
                  className="flex-1"
                  size="lg"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />{" "}
                      Uploading Both Files...
                    </>
                  ) : uploadComplete ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 mr-2" /> Uploaded
                      Successfully
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4 mr-2" /> Upload Both to
                      ReconcileAI
                    </>
                  )}
                </Button>

                {uploadComplete && (
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={() => setLocation("/reconciliation")}
                    className="flex-1"
                  >
                    Run Reconciliation{" "}
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                )}
              </div>

              {uploadComplete && (
                <div className="mt-3 flex items-center gap-3 p-3 rounded-lg bg-green-50 border border-green-200">
                  <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                  <div>
                    <p className="font-medium text-green-800 text-sm">
                      Data uploaded successfully
                    </p>
                    <p className="text-xs text-green-600">
                      Go to Reconciliation to create a new job using{" "}
                      <strong>{sourceChannelName}</strong> as source and{" "}
                      <strong>{targetChannelName}</strong> as target. Use the
                      date range {dateRangeStart} to {dateRangeEnd}.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
