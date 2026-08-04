import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Code, Send, FileText, CheckCircle2, XCircle, AlertCircle, Copy, RefreshCw } from "lucide-react";

export default function ApiIngestion() {
  const [testApiKey, setTestApiKey] = useState("");
  const [testChannelId, setTestChannelId] = useState("");
  const [testFileName, setTestFileName] = useState("test_transactions.csv");
  const [testFileContent, setTestFileContent] = useState(
    `transactionDate,amount,currency,reference,description,counterparty
2024-01-15,50000,NGN,TXN001,Payment for services,Acme Corp
2024-01-16,25000,NGN,TXN002,Refund,John Doe
2024-01-17,100000,NGN,TXN003,Invoice payment,XYZ Ltd`
  );
  const [testEncoding, setTestEncoding] = useState<"utf8" | "base64">("utf8");
  const [testResult, setTestResult] = useState<any>(null);
  const [isTestingApi, setIsTestingApi] = useState(false);

  const { data: channels } = trpc.channels.list.useQuery();
  // API keys and logs will be fetched from integrations router (to be added)
  const apiKeys: any[] = [];
  const ingestionLogs: any[] = [];
  const refetchLogs = () => {};

  const testApiUpload = async () => {
    if (!testApiKey || !testChannelId || !testFileContent) {
      toast.error("Please fill in all required fields");
      return;
    }

    setIsTestingApi(true);
    setTestResult(null);

    try {
      // Call the public API endpoint directly via fetch
      const response = await fetch("/api/trpc/publicApi.uploadTransactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          apiKey: testApiKey,
          channelId: parseInt(testChannelId),
          fileName: testFileName,
          fileContent: testFileContent,
          encoding: testEncoding,
        }),
      });

      const data = await response.json();
      setTestResult(data);

      if (data.result?.data?.success) {
        toast.success("API test successful!");
        refetchLogs();
      } else {
        toast.error("API test failed");
      }
    } catch (error: any) {
      setTestResult({ error: error.message });
      toast.error("API test failed: " + error.message);
    } finally {
      setIsTestingApi(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  return (
    <div className="container mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">API Ingestion</h1>
        <p className="text-muted-foreground mt-2">
          Integrate ReconcileAI with your banking systems via REST API
        </p>
      </div>

      <Tabs defaultValue="docs" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="docs">
            <FileText className="w-4 h-4 mr-2" />
            Documentation
          </TabsTrigger>
          <TabsTrigger value="test">
            <Send className="w-4 h-4 mr-2" />
            Test Console
          </TabsTrigger>
          <TabsTrigger value="logs">
            <Code className="w-4 h-4 mr-2" />
            Ingestion Logs
          </TabsTrigger>
        </TabsList>

        {/* Documentation Tab */}
        <TabsContent value="docs" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>API Endpoints</CardTitle>
              <CardDescription>
                Use these endpoints to upload transaction files programmatically
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Upload Transactions Endpoint */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">POST /api/trpc/publicApi.uploadTransactions</h3>
                  <Badge>Public</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  Upload transaction CSV files for a specific channel. Supports both UTF-8 and Base64 encoding.
                </p>

                <div className="bg-muted p-4 rounded-md space-y-2">
                  <p className="text-sm font-medium">Request Body:</p>
                  <pre className="text-xs overflow-x-auto">
{`{
  "apiKey": "your-api-key-here",
  "channelId": 1,
  "fileName": "transactions.csv",
  "fileContent": "transactionDate,amount,currency,...",
  "encoding": "utf8"
}`}
                  </pre>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(`{
  "apiKey": "your-api-key-here",
  "channelId": 1,
  "fileName": "transactions.csv",
  "fileContent": "transactionDate,amount,currency,...",
  "encoding": "utf8"
}`)}
                  >
                    <Copy className="w-4 h-4 mr-2" />
                    Copy
                  </Button>
                </div>

                <div className="bg-muted p-4 rounded-md space-y-2">
                  <p className="text-sm font-medium">Response (Success):</p>
                  <pre className="text-xs overflow-x-auto">
{`{
  "success": true,
  "uploadBatchId": 123,
  "totalRows": 100,
  "validRows": 98,
  "invalidRows": 2,
  "message": "Successfully uploaded 98 transactions"
}`}
                  </pre>
                </div>
              </div>

              {/* CSV Format Requirements */}
              <div className="space-y-4 pt-6 border-t">
                <h3 className="text-lg font-semibold">CSV Format Requirements</h3>
                <p className="text-sm text-muted-foreground">
                  Your CSV file must include the following columns:
                </p>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  <li><code className="bg-muted px-1 rounded">transactionDate</code> (required) - ISO 8601 or YYYY-MM-DD format</li>
                  <li><code className="bg-muted px-1 rounded">amount</code> (required) - Numeric value</li>
                  <li><code className="bg-muted px-1 rounded">currency</code> (optional) - ISO 4217 code (defaults to NGN)</li>
                  <li><code className="bg-muted px-1 rounded">reference</code> (optional) - Transaction reference number</li>
                  <li><code className="bg-muted px-1 rounded">description</code> (optional) - Transaction description</li>
                  <li><code className="bg-muted px-1 rounded">counterparty</code> (optional) - Counterparty name</li>
                </ul>
              </div>

              {/* Authentication */}
              <div className="space-y-4 pt-6 border-t">
                <h3 className="text-lg font-semibold">Authentication</h3>
                <p className="text-sm text-muted-foreground">
                  All API requests require a valid API key. You can create and manage API keys in the{" "}
                  <a href="/integrations" className="text-primary hover:underline">Integrations</a> page.
                </p>
                <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 p-4 rounded-md">
                  <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                    <AlertCircle className="w-4 h-4 inline mr-2" />
                    Security Note
                  </p>
                  <p className="text-sm text-amber-800 dark:text-amber-200 mt-1">
                    Never expose your API keys in client-side code or public repositories. Always call the API from your backend server.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Test Console Tab */}
        <TabsContent value="test" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>API Test Console</CardTitle>
              <CardDescription>
                Test your API integration with sample data
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="test-api-key">API Key *</Label>
                <div className="flex gap-2">
                  <Input
                    id="test-api-key"
                    type="password"
                    placeholder="Enter your API key"
                    value={testApiKey}
                    onChange={(e) => setTestApiKey(e.target.value)}
                  />
                  {/* API key selector will be enabled once integrations router is added */}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="test-channel">Channel *</Label>
                <Select value={testChannelId} onValueChange={setTestChannelId}>
                  <SelectTrigger id="test-channel">
                    <SelectValue placeholder="Select a channel" />
                  </SelectTrigger>
                  <SelectContent>
                    {channels?.map((channel) => (
                      <SelectItem key={channel.id} value={String(channel.id)}>
                        {channel.name} ({channel.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="test-filename">File Name</Label>
                <Input
                  id="test-filename"
                  value={testFileName}
                  onChange={(e) => setTestFileName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="test-encoding">Encoding</Label>
                <Select value={testEncoding} onValueChange={(v: "utf8" | "base64") => setTestEncoding(v)}>
                  <SelectTrigger id="test-encoding">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="utf8">UTF-8 (Plain Text)</SelectItem>
                    <SelectItem value="base64">Base64</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="test-content">CSV Content *</Label>
                <Textarea
                  id="test-content"
                  rows={10}
                  className="font-mono text-xs"
                  value={testFileContent}
                  onChange={(e) => setTestFileContent(e.target.value)}
                />
              </div>

              <Button
                onClick={testApiUpload}
                disabled={isTestingApi}
                className="w-full"
              >
                {isTestingApi ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    Testing...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4 mr-2" />
                    Test API Upload
                  </>
                )}
              </Button>

              {testResult && (
                <div className="mt-4 p-4 bg-muted rounded-md">
                  <p className="text-sm font-medium mb-2">Response:</p>
                  <pre className="text-xs overflow-x-auto">
                    {JSON.stringify(testResult, null, 2)}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Logs Tab */}
        <TabsContent value="logs" className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Ingestion Logs</CardTitle>
                  <CardDescription>
                    View recent API upload activity
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={() => refetchLogs()}>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {!ingestionLogs || ingestionLogs.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Code className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No ingestion logs yet</p>
                  <p className="text-sm mt-1">Upload files via the API to see activity here</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {ingestionLogs.map((log: any) => (
                    <div
                      key={log.id}
                      className="flex items-start justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                    >
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2">
                          {log.status === "success" ? (
                            <CheckCircle2 className="w-4 h-4 text-green-600" />
                          ) : log.status === "partial" ? (
                            <AlertCircle className="w-4 h-4 text-amber-600" />
                          ) : (
                            <XCircle className="w-4 h-4 text-red-600" />
                          )}
                          <span className="font-medium">{log.fileName || "Unnamed file"}</span>
                          <Badge variant={log.status === "success" ? "default" : "destructive"}>
                            {log.status}
                          </Badge>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {log.validRows || 0} valid, {log.invalidRows || 0} invalid • {log.processingTimeMs || 0}ms
                        </div>
                        {log.errorMessage && (
                          <div className="text-sm text-red-600 dark:text-red-400">
                            {log.errorMessage}
                          </div>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground text-right">
                        {new Date(log.createdAt).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
