import { useState, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Upload as UploadIcon, FileSpreadsheet, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

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

export default function UploadPage() {
  const { data: channels, isLoading: channelsLoading } = trpc.channels.list.useQuery();
  const uploadMutation = trpc.upload.createBatch.useMutation();
  const { data: history, refetch: refetchHistory } = trpc.upload.history.useQuery();

  const [selectedChannel, setSelectedChannel] = useState<string>("");
  const [parsedData, setParsedData] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ validRows: number; invalidRows: number; totalRows: number } | null>(null);

  const parseCSV = useCallback((text: string): ParsedRow[] => {
    const lines = text.trim().split("\n");
    if (lines.length < 2) return [];
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/['"]/g, ""));
    const rows: ParsedRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(",").map((v) => v.trim().replace(/^["']|["']$/g, ""));
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => { row[h] = values[idx] || ""; });

      const amount = row.amount || row.transaction_amount || row.value || "";
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum)) continue;

      const dateStr = row.date || row.transaction_date || row.transactiondate || row.txn_date || "";
      if (!dateStr) continue;

      const debitCredit = (row.type || row.debit_credit || row.debitcredit || row.direction || "").toLowerCase();
      const dc: "debit" | "credit" = debitCredit.includes("credit") || debitCredit === "cr" || amountNum > 0 ? "credit" : "debit";

      rows.push({
        transactionRef: row.reference || row.ref || row.transaction_ref || row.txn_ref || "",
        externalRef: row.external_ref || row.ext_ref || row.counterparty_ref || "",
        description: row.description || row.narration || row.memo || row.details || "",
        amount: String(Math.abs(amountNum)),
        currency: row.currency || "NGN",
        transactionDate: dateStr,
        valueDate: row.value_date || row.valuedate || "",
        debitCredit: dc,
        counterparty: row.counterparty || row.beneficiary || row.sender || "",
        rawData: row,
      });
    }
    return rows;
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setFileName(file.name);
      setResult(null);

      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        if (file.name.endsWith(".csv") || file.name.endsWith(".txt")) {
          const parsed = parseCSV(text);
          setParsedData(parsed);
          if (parsed.length === 0) {
            toast.error("No valid transactions found in file. Please check the format.");
          } else {
            toast.success(`Parsed ${parsed.length} transactions from ${file.name}`);
          }
        } else {
          toast.error("Unsupported file format. Please upload a CSV file.");
        }
      };
      reader.readAsText(file);
    },
    [parseCSV]
  );

  const handleUpload = async () => {
    if (!selectedChannel || parsedData.length === 0) {
      toast.error("Please select a channel and upload a file.");
      return;
    }
    setUploading(true);
    try {
      const res = await uploadMutation.mutateAsync({
        channelCode: selectedChannel,
        fileName,
        transactions: parsedData,
      });
      setResult(res);
      toast.success(`Upload complete: ${res.validRows} valid, ${res.invalidRows} invalid`);
      refetchHistory();
      setParsedData([]);
      setFileName("");
    } catch (err: any) {
      toast.error(err.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-primary">Upload Transactions</h1>
        <p className="text-muted-foreground mt-1">Import transaction data from CSV files for reconciliation</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Upload Form */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Upload Transaction File</CardTitle>
              <CardDescription>Select a payment channel and upload a CSV file with transaction data</CardDescription>
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
                <div className="border-2 border-dashed rounded-lg p-8 text-center hover:border-primary/50 transition-colors">
                  <input
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
                        <span className="text-sm text-muted-foreground">{parsedData.length} transactions parsed</span>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <UploadIcon className="h-10 w-10 text-muted-foreground" />
                        <span className="font-medium">Click to upload CSV file</span>
                        <span className="text-xs text-muted-foreground">Supports CSV format with headers</span>
                      </div>
                    )}
                  </label>
                </div>
              </div>

              {parsedData.length > 0 && (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="text-left py-2 px-3">Reference</th>
                        <th className="text-left py-2 px-3">Date</th>
                        <th className="text-right py-2 px-3">Amount</th>
                        <th className="text-left py-2 px-3">Type</th>
                        <th className="text-left py-2 px-3">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedData.slice(0, 5).map((row, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-2 px-3 font-mono">{row.transactionRef || "-"}</td>
                          <td className="py-2 px-3">{row.transactionDate}</td>
                          <td className="py-2 px-3 text-right">{parseFloat(row.amount).toLocaleString()}</td>
                          <td className="py-2 px-3">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${row.debitCredit === "credit" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                              {row.debitCredit.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-2 px-3 max-w-[200px] truncate">{row.description || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {parsedData.length > 5 && (
                    <div className="text-xs text-muted-foreground text-center py-2">
                      ...and {parsedData.length - 5} more rows
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
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Uploading...
                  </>
                ) : (
                  <>
                    <UploadIcon className="h-4 w-4 mr-2" /> Upload {parsedData.length} Transactions
                  </>
                )}
              </Button>

              {result && (
                <div className="flex items-center gap-3 p-4 rounded-lg bg-green-50 border border-green-200">
                  <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                  <div>
                    <p className="font-medium text-green-800">Upload Successful</p>
                    <p className="text-sm text-green-600">
                      {result.validRows} valid / {result.invalidRows} invalid out of {result.totalRows} total
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Upload Instructions */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">CSV Format Guide</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-3">
              <p className="text-muted-foreground">Your CSV file should include the following columns:</p>
              <div className="space-y-2">
                {[
                  { name: "reference", desc: "Transaction reference", required: false },
                  { name: "date", desc: "Transaction date", required: true },
                  { name: "amount", desc: "Transaction amount", required: true },
                  { name: "type", desc: "debit or credit", required: true },
                  { name: "description", desc: "Narration/memo", required: false },
                  { name: "counterparty", desc: "Other party", required: false },
                ].map((col) => (
                  <div key={col.name} className="flex items-start gap-2">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{col.name}</code>
                    <span className="text-xs text-muted-foreground">{col.desc}</span>
                    {col.required && <span className="text-[10px] text-red-500 font-medium">Required</span>}
                  </div>
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
                    <div className="h-2 w-2 rounded-full bg-primary" />
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
                  {history.map((batch) => (
                    <tr key={batch.id} className="border-b last:border-0">
                      <td className="py-3 px-2 font-medium">{batch.fileName}</td>
                      <td className="py-3 px-2">{channels?.find((c) => c.id === batch.channelId)?.name || "-"}</td>
                      <td className="py-3 px-2 text-right">{batch.totalRows}</td>
                      <td className="py-3 px-2 text-right text-green-600">{batch.validRows}</td>
                      <td className="py-3 px-2 text-right text-red-500">{batch.invalidRows}</td>
                      <td className="py-3 px-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          batch.status === "completed" ? "bg-green-100 text-green-700" :
                          batch.status === "processing" ? "bg-blue-100 text-blue-700" :
                          "bg-red-100 text-red-700"
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
