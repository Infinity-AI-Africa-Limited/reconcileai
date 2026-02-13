import { useState, useCallback, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Upload as UploadIcon, FileSpreadsheet, CheckCircle2, AlertCircle, X, Info } from "lucide-react";
import { toast } from "sonner";

// ─── Constants ──────────────────────────────────────────────────────

const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_TRANSACTIONS = 10000;
const SUPPORTED_CURRENCIES = [
  "NGN", "GHS", "KES", "TZS", "UGX", "ZAR", "EGP", "XOF", "XAF",
  "RWF", "ETB", "MAD", "USD", "EUR", "GBP",
];

// ─── Types ──────────────────────────────────────────────────────────

type ParsedRow = {
  transactionRef?: string;
  externalRef?: string;
  description?: string;
  amount: string;
  currency: string;
  transactionDate: string;
  valueDate?: string;
  debitCredit: "debit" | "credit";
  counterparty?: string;
  rawData?: any;
};

type ValidationError = {
  row: number;
  field: string;
  message: string;
};

// ─── File Hash Utility ──────────────────────────────────────────────

async function computeFileHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── CSV Parser ─────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(text: string): { rows: ParsedRow[]; errors: ValidationError[] } {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { rows: [], errors: [{ row: 0, field: "file", message: "File must have a header row and at least one data row" }] };

  const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase().replace(/['"]/g, "").replace(/\s+/g, "_"));
  const rows: ParsedRow[] = [];
  const errors: ValidationError[] = [];

  // Validate required headers exist
  const hasAmount = headers.some((h) => ["amount", "transaction_amount", "value", "txn_amount"].includes(h));
  const hasDate = headers.some((h) => ["date", "transaction_date", "transactiondate", "txn_date", "posting_date"].includes(h));
  if (!hasAmount) errors.push({ row: 0, field: "headers", message: "Missing required column: amount (or transaction_amount, value)" });
  if (!hasDate) errors.push({ row: 0, field: "headers", message: "Missing required column: date (or transaction_date, txn_date)" });
  if (errors.length > 0) return { rows, errors };

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue; // skip empty lines

    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ""; });

    // Parse amount
    const amountStr = row.amount || row.transaction_amount || row.value || row.txn_amount || "";
    const cleanedAmount = amountStr.replace(/[,\s]/g, ""); // Remove commas and spaces
    const amountNum = parseFloat(cleanedAmount);
    if (isNaN(amountNum) || !isFinite(amountNum)) {
      errors.push({ row: i + 1, field: "amount", message: `Invalid amount: "${amountStr}"` });
      continue;
    }
    if (Math.abs(amountNum) > 999999999999.99) {
      errors.push({ row: i + 1, field: "amount", message: `Amount exceeds maximum: ${amountStr}` });
      continue;
    }

    // Parse date
    const dateStr = row.date || row.transaction_date || row.transactiondate || row.txn_date || row.posting_date || "";
    if (!dateStr) {
      errors.push({ row: i + 1, field: "date", message: "Missing transaction date" });
      continue;
    }
    const parsedDate = new Date(dateStr);
    if (isNaN(parsedDate.getTime())) {
      errors.push({ row: i + 1, field: "date", message: `Invalid date format: "${dateStr}"` });
      continue;
    }

    // Parse direction
    const dirStr = (row.type || row.debit_credit || row.debitcredit || row.direction || row.dr_cr || "").toLowerCase();
    const dc: "debit" | "credit" = dirStr.includes("credit") || dirStr === "cr" || dirStr === "c"
      ? "credit"
      : dirStr.includes("debit") || dirStr === "dr" || dirStr === "d"
        ? "debit"
        : amountNum >= 0 ? "credit" : "debit";

    // Parse currency
    const currency = (row.currency || row.ccy || "NGN").toUpperCase().trim();
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      errors.push({ row: i + 1, field: "currency", message: `Unsupported currency: "${currency}". Supported: ${SUPPORTED_CURRENCIES.join(", ")}` });
      continue;
    }

    rows.push({
      transactionRef: row.reference || row.ref || row.transaction_ref || row.txn_ref || row.transaction_reference || "",
      externalRef: row.external_ref || row.ext_ref || row.counterparty_ref || row.session_id || "",
      description: row.description || row.narration || row.memo || row.details || row.remarks || "",
      amount: String(Math.abs(amountNum)),
      currency,
      transactionDate: parsedDate.toISOString(),
      valueDate: row.value_date || row.valuedate || row.settlement_date || "",
      debitCredit: dc,
      counterparty: row.counterparty || row.beneficiary || row.sender || row.other_party || row.account_name || "",
      rawData: row,
    });
  }

  return { rows, errors };
}

// ─── Component ──────────────────────────────────────────────────────

export default function UploadPage() {
  const { data: channels, isLoading: channelsLoading } = trpc.channels.list.useQuery();
  const uploadMutation = trpc.upload.createBatch.useMutation();
  const { data: history, refetch: refetchHistory } = trpc.upload.history.useQuery();

  const [selectedChannel, setSelectedChannel] = useState<string>("");
  const [parsedData, setParsedData] = useState<ParsedRow[]>([]);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [fileHash, setFileHash] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [result, setResult] = useState<{ validRows: number; invalidRows: number; totalRows: number; deduplicated?: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    // File size check
    if (file.size > MAX_FILE_SIZE_BYTES) {
      toast.error(`File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`);
      return;
    }

    // File type check
    const validExtensions = [".csv", ".txt"];
    const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
    if (!validExtensions.includes(ext)) {
      toast.error("Unsupported file format. Please upload a CSV or TXT file.");
      return;
    }

    setFileName(file.name);
    setResult(null);
    setValidationErrors([]);

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target?.result as string;

      // Compute file hash for idempotency
      const hash = await computeFileHash(text);
      setFileHash(hash);

      const { rows, errors } = parseCSV(text);
      setParsedData(rows);
      setValidationErrors(errors);

      if (rows.length > MAX_TRANSACTIONS) {
        toast.error(`File contains ${rows.length} transactions. Maximum is ${MAX_TRANSACTIONS.toLocaleString()}.`);
        setParsedData(rows.slice(0, MAX_TRANSACTIONS));
        return;
      }

      if (rows.length === 0 && errors.length > 0) {
        toast.error(`No valid transactions found. ${errors.length} validation error(s).`);
      } else if (errors.length > 0) {
        toast.warning(`Parsed ${rows.length} transactions with ${errors.length} error(s).`);
      } else {
        toast.success(`Parsed ${rows.length} transactions from ${file.name}`);
      }
    };
    reader.onerror = () => toast.error("Failed to read file. Please try again.");
    reader.readAsText(file);
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const clearFile = useCallback(() => {
    setParsedData([]);
    setValidationErrors([]);
    setFileName("");
    setFileHash("");
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const handleUpload = async () => {
    if (!selectedChannel || parsedData.length === 0) {
      toast.error("Please select a channel and upload a file with valid transactions.");
      return;
    }
    setUploading(true);
    try {
      const res = await uploadMutation.mutateAsync({
        channelCode: selectedChannel,
        fileName,
        fileHash: fileHash || undefined,
        transactions: parsedData,
      });
      setResult(res);
      if (res.deduplicated) {
        toast.info("This file was already uploaded. Returning existing batch.");
      } else {
        toast.success(`Upload complete: ${res.validRows} valid, ${res.invalidRows} invalid`);
      }
      refetchHistory();
    } catch (err: any) {
      toast.error(err.message || "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  // Currency summary
  const currencySummary = parsedData.reduce((acc, row) => {
    const key = row.currency || "NGN";
    if (!acc[key]) acc[key] = { count: 0, total: 0 };
    acc[key].count++;
    acc[key].total += parseFloat(row.amount);
    return acc;
  }, {} as Record<string, { count: number; total: number }>);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-primary">Upload Transactions</h1>
        <p className="text-muted-foreground mt-1">Import transaction data from CSV files for reconciliation across African banking channels</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Upload Transaction File</CardTitle>
              <CardDescription>Select a payment channel and upload a CSV file. Max {MAX_FILE_SIZE_MB}MB, up to {MAX_TRANSACTIONS.toLocaleString()} transactions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Payment Channel</label>
                {channelsLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Select value={selectedChannel} onValueChange={setSelectedChannel}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select channel..." />
                    </SelectTrigger>
                    <SelectContent>
                      {channels?.map((ch) => (
                        <SelectItem key={ch.id} value={ch.code}>
                          {ch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Transaction File (CSV)</label>
                <div
                  className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors relative ${
                    isDragging ? "border-primary bg-primary/5" : "hover:border-primary/50"
                  }`}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.txt"
                    onChange={handleFileChange}
                    className="hidden"
                    id="file-upload"
                  />
                  <label htmlFor="file-upload" className="cursor-pointer">
                    {fileName ? (
                      <div className="flex flex-col items-center gap-2">
                        <FileSpreadsheet className="h-10 w-10 text-primary" />
                        <span className="font-medium">{fileName}</span>
                        <span className="text-sm text-muted-foreground">{parsedData.length} valid transactions parsed</span>
                        {validationErrors.length > 0 && (
                          <span className="text-sm text-amber-600">{validationErrors.length} row(s) with errors</span>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <UploadIcon className="h-10 w-10 text-muted-foreground" />
                        <span className="font-medium">Click or drag and drop CSV file</span>
                        <span className="text-xs text-muted-foreground">Supports CSV format with headers. Max {MAX_FILE_SIZE_MB}MB.</span>
                      </div>
                    )}
                  </label>
                  {fileName && (
                    <button
                      onClick={(e) => { e.preventDefault(); clearFile(); }}
                      className="absolute top-2 right-2 p-1 rounded-full hover:bg-muted transition-colors"
                    >
                      <X className="h-4 w-4 text-muted-foreground" />
                    </button>
                  )}
                </div>
              </div>

              {/* Validation Errors */}
              {validationErrors.length > 0 && (
                <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle className="h-4 w-4 text-amber-600" />
                    <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
                      {validationErrors.length} Validation Error(s)
                    </span>
                  </div>
                  <div className="max-h-32 overflow-y-auto space-y-1">
                    {validationErrors.slice(0, 10).map((err, i) => (
                      <p key={i} className="text-xs text-amber-700 dark:text-amber-300">
                        Row {err.row}: {err.message}
                      </p>
                    ))}
                    {validationErrors.length > 10 && (
                      <p className="text-xs text-amber-600">...and {validationErrors.length - 10} more</p>
                    )}
                  </div>
                </div>
              )}

              {/* Currency Summary */}
              {Object.keys(currencySummary).length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {Object.entries(currencySummary).map(([ccy, data]) => (
                    <div key={ccy} className="bg-muted/50 rounded-lg px-3 py-2 text-xs">
                      <span className="font-semibold">{ccy}</span>
                      <span className="text-muted-foreground ml-2">{data.count} txns</span>
                      <span className="text-muted-foreground ml-2">Total: {data.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Preview Table */}
              {parsedData.length > 0 && (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="text-left py-2 px-3">Reference</th>
                        <th className="text-left py-2 px-3">Date</th>
                        <th className="text-left py-2 px-3">Currency</th>
                        <th className="text-right py-2 px-3">Amount</th>
                        <th className="text-left py-2 px-3">Type</th>
                        <th className="text-left py-2 px-3">Counterparty</th>
                        <th className="text-left py-2 px-3">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedData.slice(0, 8).map((row, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-2 px-3 font-mono text-[11px]">{row.transactionRef || "-"}</td>
                          <td className="py-2 px-3">{new Date(row.transactionDate).toLocaleDateString()}</td>
                          <td className="py-2 px-3 font-medium">{row.currency}</td>
                          <td className="py-2 px-3 text-right font-mono">
                            {parseFloat(row.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </td>
                          <td className="py-2 px-3">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              row.debitCredit === "credit" ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                            }`}>
                              {row.debitCredit.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-2 px-3 max-w-[120px] truncate">{row.counterparty || "-"}</td>
                          <td className="py-2 px-3 max-w-[150px] truncate">{row.description || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {parsedData.length > 8 && (
                    <div className="text-xs text-muted-foreground text-center py-2 border-t">
                      Showing 8 of {parsedData.length} transactions
                    </div>
                  )}
                </div>
              )}

              <Button
                onClick={handleUpload}
                disabled={!selectedChannel || parsedData.length === 0 || uploading}
                className="w-full"
              >
                {uploading ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Uploading {parsedData.length.toLocaleString()} transactions...</>
                ) : (
                  <><UploadIcon className="h-4 w-4 mr-2" /> Upload {parsedData.length.toLocaleString()} Transactions</>
                )}
              </Button>

              {result && (
                <div className={`flex items-center gap-3 p-4 rounded-lg ${
                  result.deduplicated
                    ? "bg-blue-50 border border-blue-200 dark:bg-blue-950 dark:border-blue-800"
                    : "bg-green-50 border border-green-200 dark:bg-green-950 dark:border-green-800"
                }`}>
                  {result.deduplicated ? (
                    <Info className="h-5 w-5 text-blue-600 shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                  )}
                  <div>
                    <p className={`font-medium ${result.deduplicated ? "text-blue-800 dark:text-blue-200" : "text-green-800 dark:text-green-200"}`}>
                      {result.deduplicated ? "Duplicate Upload Detected" : "Upload Successful"}
                    </p>
                    <p className={`text-sm ${result.deduplicated ? "text-blue-600 dark:text-blue-300" : "text-green-600 dark:text-green-300"}`}>
                      {result.deduplicated
                        ? "This file was already uploaded. The existing batch was returned."
                        : `${result.validRows} valid / ${result.invalidRows} invalid out of ${result.totalRows} total`
                      }
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">CSV Format Guide</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-3">
              <p className="text-muted-foreground">Your CSV file should include the following columns:</p>
              <div className="space-y-2">
                {[
                  { name: "reference", desc: "Transaction reference / ID", required: false },
                  { name: "date", desc: "Transaction date (ISO, DD/MM/YYYY, etc.)", required: true },
                  { name: "amount", desc: "Transaction amount (numeric)", required: true },
                  { name: "type", desc: "debit / credit / DR / CR", required: false },
                  { name: "currency", desc: "3-letter code (default: NGN)", required: false },
                  { name: "description", desc: "Narration / memo", required: false },
                  { name: "counterparty", desc: "Beneficiary / sender name", required: false },
                  { name: "value_date", desc: "Settlement / value date", required: false },
                ].map((col) => (
                  <div key={col.name} className="flex items-start gap-2">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono shrink-0">{col.name}</code>
                    <span className="text-xs text-muted-foreground flex-1">{col.desc}</span>
                    {col.required && <span className="text-[10px] text-red-500 font-medium shrink-0">Required</span>}
                  </div>
                ))}
              </div>
              <div className="bg-muted/50 rounded-lg p-3 mt-3">
                <p className="text-xs text-muted-foreground">
                  <strong>Flexible headers:</strong> The parser accepts common variations like <code>transaction_date</code>, <code>txn_ref</code>, <code>narration</code>, <code>beneficiary</code>, <code>dr_cr</code>, etc.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Supported Currencies</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5">
                {SUPPORTED_CURRENCIES.map((ccy) => (
                  <span key={ccy} className="px-2 py-0.5 bg-muted rounded text-xs font-mono">{ccy}</span>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Supported Channels</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {channels?.map((ch) => (
                  <div key={ch.id} className="flex items-center gap-2 text-sm">
                    <div className="h-2 w-2 rounded-full bg-primary shrink-0" />
                    <span>{ch.name}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Upload History */}
      {history && history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Upload History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">File</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Channel</th>
                    <th className="text-right py-3 px-2 font-medium text-muted-foreground">Total</th>
                    <th className="text-right py-3 px-2 font-medium text-muted-foreground">Valid</th>
                    <th className="text-right py-3 px-2 font-medium text-muted-foreground">Invalid</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((batch: any) => (
                    <tr key={batch.id} className="border-b last:border-0">
                      <td className="py-3 px-2 font-medium max-w-[200px] truncate">{batch.fileName}</td>
                      <td className="py-3 px-2">{channels?.find((c) => c.id === batch.channelId)?.name || "-"}</td>
                      <td className="py-3 px-2 text-right">{batch.totalRows}</td>
                      <td className="py-3 px-2 text-right text-green-600">{batch.validRows}</td>
                      <td className="py-3 px-2 text-right text-red-500">{batch.invalidRows}</td>
                      <td className="py-3 px-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          batch.status === "completed" ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" :
                          batch.status === "processing" ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" :
                          "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                        }`}>
                          {batch.status}
                        </span>
                      </td>
                      <td className="py-3 px-2 text-muted-foreground">{new Date(batch.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
