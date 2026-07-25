/**
 * Local Deployment & Model Training runbook — privately shared document page.
 *
 * Mounted behind <PocAccessGate pocKey="deployment_runbook">, so it is reachable
 * only with an invite link (`/deployment-runbook?key=…`) issued from the POC Hub.
 * The document body is fetched from the access-gated `poc.runbook` procedure
 * rather than bundled into the client, so the link is a real boundary.
 */
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Check, Download, Loader2, Lock, Printer, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

const POC_KEY = "deployment_runbook";

export default function DeploymentRunbook() {
  const [downloaded, setDownloaded] = useState(false);
  const doc = trpc.poc.runbook.useQuery(
    { pocSlug: POC_KEY },
    { refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 },
  );

  const fileName = useMemo(
    () => `ReconcileAI_Local_Deployment_and_Model_Training_v${doc.data?.version ?? "2.0"}.md`,
    [doc.data?.version],
  );

  const download = () => {
    if (!doc.data?.markdown) return;
    try {
      const blob = new Blob([doc.data.markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 2500);
    } catch {
      toast.error("Could not download the document. Try printing to PDF instead.");
    }
  };

  if (doc.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="h-6 w-6 animate-spin text-[#1B365D]" />
      </div>
    );
  }

  if (doc.error || !doc.data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-6">
        <div className="w-full max-w-sm rounded-2xl border bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
            <Lock className="h-6 w-6 text-red-600" />
          </div>
          <h1 className="text-lg font-semibold text-gray-900">Document unavailable</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            This link may have been revoked or replaced. Ask your ReconcileAI contact for a
            current invite link.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 print:bg-white">
      {/* Document header */}
      <header className="border-b bg-white print:border-0">
        <div className="mx-auto max-w-4xl px-6 py-8 sm:py-10">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#F47458]">
            ◆ ReconcileAI · Infinity AI Africa Limited
          </p>
          <h1 className="mt-3 text-3xl font-bold leading-tight text-[#1B365D] sm:text-4xl">
            {doc.data.title}
          </h1>
          <p className="mt-2 max-w-2xl text-base text-slate-600">{doc.data.subtitle}</p>

          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[11px] uppercase tracking-wider text-slate-500">
            <span>Version {doc.data.version}</span>
            <span>{doc.data.updated}</span>
            <span>Nigeria · Uganda</span>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2 print:hidden">
            <Button size="sm" onClick={download} className="gap-2 bg-[#1B365D] hover:bg-[#16294a]">
              {downloaded ? <Check className="h-4 w-4" /> : <Download className="h-4 w-4" />}
              {downloaded ? "Downloaded" : "Download Markdown"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.print()} className="gap-2">
              <Printer className="h-4 w-4" /> Print / Save as PDF
            </Button>
          </div>

          <div className="mt-6 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900 print:hidden">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Shared privately by invitation. Please do not forward this link — ask us to issue a
              separate one for each recipient so access can be revoked individually.
            </span>
          </div>
        </div>
      </header>

      {/* Document body */}
      <main className="mx-auto max-w-4xl px-6 py-10">
        <article
          className="
            prose prose-slate max-w-none
            prose-headings:text-[#1B365D] prose-headings:font-bold
            prose-h1:text-3xl prose-h1:mb-2
            prose-h2:mt-12 prose-h2:border-t prose-h2:border-slate-200 prose-h2:pt-8 prose-h2:text-2xl
            prose-h3:mt-8 prose-h3:text-lg
            prose-a:text-[#1B365D] prose-a:underline-offset-2
            prose-strong:text-[#1B365D]
            prose-blockquote:border-l-[3px] prose-blockquote:border-[#F47458]
            prose-blockquote:bg-[#F47458]/5 prose-blockquote:py-1 prose-blockquote:px-4
            prose-blockquote:not-italic prose-blockquote:text-slate-700
            prose-code:text-[#1B365D] prose-code:before:content-[''] prose-code:after:content-['']
            prose-code:bg-slate-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
            prose-pre:bg-[#0E1B2C] prose-pre:text-slate-100 prose-pre:border-l-[3px]
            prose-pre:border-[#F47458] prose-pre:rounded-md prose-pre:overflow-x-auto
            prose-table:text-sm
            prose-th:bg-[#1B365D] prose-th:text-white prose-th:font-semibold
            prose-th:px-3 prose-th:py-2 prose-th:text-left
            prose-td:px-3 prose-td:py-2 prose-td:align-top
            print:prose-sm
          "
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Tables can be wider than the column on small screens — let each
              // one scroll inside its own container so the page never does.
              table: ({ children }) => (
                <div className="overflow-x-auto">
                  <table>{children}</table>
                </div>
              ),
            }}
          >
            {doc.data.markdown}
          </ReactMarkdown>
        </article>

        <footer className="mt-14 border-t pt-6 text-xs text-slate-500">
          ReconcileAI is a product of Infinity AI Africa Limited · Version {doc.data.version} ·{" "}
          {doc.data.updated} · Shared under invitation.
        </footer>
      </main>
    </div>
  );
}
