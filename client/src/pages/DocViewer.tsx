import { useEffect, useState } from "react";
import { useRoute, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function DocViewer() {
  const [, params] = useRoute("/docs/:docName");
  const [content, setContent] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const docName = params?.docName;
  // If docName already starts with ReconcileAI_, use it as is, otherwise prepend it
  const filename = docName?.startsWith("ReconcileAI_") 
    ? `${docName}.md` 
    : `ReconcileAI_${docName?.replace(/-/g, "_")}.md`;

  useEffect(() => {
    const fetchDoc = async () => {
      if (!docName) return;

      setIsLoading(true);
      setError(null);

      try {
        const input = { "0": { json: { filename } } };
        const response = await fetch(
          `/api/trpc/docs.download?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`
        );

        if (!response.ok) {
          throw new Error("Failed to fetch documentation");
        }

        const data = await response.json();
        const result = data[0].result.data.json;
        setContent(result.content);
      } catch (err) {
        console.error("Error fetching documentation:", err);
        setError("Failed to load documentation. Please try again later.");
        toast.error("Failed to load documentation");
      } finally {
        setIsLoading(false);
      }
    };

    fetchDoc();
  }, [docName, filename]);

  const handleDownload = async () => {
    try {
      toast.info(`Downloading ${filename}...`);

      const blob = new Blob([content], { type: "text/markdown" });
      const url = window.URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      toast.success(`${filename} downloaded successfully`);
    } catch (error) {
      toast.error(`Failed to download ${filename}`);
      console.error("Download error:", error);
    }
  };

  const getTitle = () => {
    if (docName === "Quick_Start") return "Quick Start Guide";
    if (docName === "User_Guide") return "User Guide";
    if (docName === "Admin_Guide") return "Administrator Guide";
    return "Documentation";
  };

  if (isLoading) {
    return (
      <div className="container mx-auto py-8">
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin text-[#1B365D]" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto py-8">
        <Card className="border-red-200 bg-red-50">
          <CardHeader>
            <CardTitle className="text-red-900">Error Loading Documentation</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-red-800 mb-4">{error}</p>
            <Link href="/documentation">
              <Button variant="outline">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Documentation
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/documentation">
            <Button variant="outline" size="sm">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </Link>
          <h1 className="text-3xl font-bold text-[#1B365D]">{getTitle()}</h1>
        </div>
        <Button onClick={handleDownload} variant="default">
          <Download className="h-4 w-4 mr-2" />
          Download
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="prose prose-slate max-w-none prose-headings:text-[#1B365D] prose-a:text-[#F4758C] prose-strong:text-[#1B365D]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
