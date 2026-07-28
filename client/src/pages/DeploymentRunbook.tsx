/**
 * Local Deployment & Model Training runbook — privately shared document page.
 *
 * Mounted behind <PocAccessGate pocKey="deployment_runbook">, so it is reachable
 * only with an invite link (`/deployment-runbook?key=…`) issued from the POC Hub.
 * The document body is fetched from the access-gated `poc.runbook` procedure
 * rather than bundled into the client, so the link is a real boundary.
 *
 * Read-only presentation: printing/PDF export, text selection, copy/cut, the
 * context menu and file download are all suppressed, and the page is blanked in
 * print media. Treat this as deterrence, not protection — anything rendered in a
 * browser can still be read from devtools, the network response, or a photo of
 * the screen. The access token remains the actual control.
 */
import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { trpc } from "@/lib/trpc";
import { Loader2, Lock, ShieldCheck } from "lucide-react";

const POC_KEY = "deployment_runbook";

/**
 * Suppresses selection/callout on screen and blanks the document for print, so
 * Ctrl+P / "Save as PDF" / "Print to PDF" yield a confidentiality notice rather
 * than the document. Scoped to this page's lifetime because it renders inside
 * the component.
 */
const PROTECTION_CSS = `
.rb-protected, .rb-protected * {
  -webkit-user-select: none !important;
  -moz-user-select: none !important;
  -ms-user-select: none !important;
  user-select: none !important;
  -webkit-touch-callout: none !important;
}
@media print {
  body > * { display: none !important; }
  body::before {
    content: "ReconcileAI — Confidential. This document is shared under invitation and may not be printed, exported or reproduced. Contact your ReconcileAI representative if you need a copy.";
    display: block;
    padding: 4rem 3rem;
    max-width: 34rem;
    font: 600 12pt/1.7 Georgia, "Times New Roman", serif;
    color: #1B365D;
  }
}
`;

/** XML-escape a label before it goes into the inline SVG watermark. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Repeating diagonal watermark carrying whoever the link was issued to. It does
 * not stop a screenshot — it makes a leaked screenshot attributable, which is
 * the deterrent that actually works on an invited reader.
 */
function watermarkStyle(label: string): React.CSSProperties {
  const text = xmlEscape(label);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="240">` +
    `<text x="20" y="130" transform="rotate(-30 210 120)" ` +
    `font-family="Segoe UI,Helvetica,Arial,sans-serif" font-size="15" font-weight="600" ` +
    `fill="#1B365D" fill-opacity="0.075">${text}</text></svg>`;
  return { backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")` };
}

export default function DeploymentRunbook() {
  const doc = trpc.poc.runbook.useQuery(
    { pocSlug: POC_KEY },
    { refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 },
  );

  // Block copy/cut/context-menu and the print/save/select shortcuts while this
  // page is mounted. Listeners are attached in the capture phase so page content
  // cannot opt out, and are removed on unmount so the rest of the app is normal.
  useEffect(() => {
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // p = print, s = save page, c/x = copy/cut, a = select all
      if (["p", "s", "c", "x", "a"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("copy", swallow, true);
    document.addEventListener("cut", swallow, true);
    document.addEventListener("contextmenu", swallow, true);
    document.addEventListener("dragstart", swallow, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("copy", swallow, true);
      document.removeEventListener("cut", swallow, true);
      document.removeEventListener("contextmenu", swallow, true);
      document.removeEventListener("dragstart", swallow, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

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

  const issuedTo = doc.data.viewer
    ? `Issued to ${doc.data.viewer}`
    : "Confidential — shared by invitation";
  const stamp = `${issuedTo} · ${new Date().toISOString().slice(0, 10)}`;

  return (
    <div className="rb-protected relative min-h-screen bg-slate-50">
      <style>{PROTECTION_CSS}</style>

      {/* Attribution watermark — sits above the content, ignores pointer events. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-50 select-none"
        style={watermarkStyle(stamp)}
      />

      {/* Document header */}
      <header className="border-b bg-white">
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

          <div className="mt-6 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Confidential — shared privately by invitation, for reading on screen only. This
              document may not be printed, exported, copied or forwarded.
              {doc.data.viewer ? (
                <>
                  {" "}This copy was issued to <strong>{doc.data.viewer}</strong> and is watermarked
                  throughout; any reproduction remains traceable to that recipient.
                </>
              ) : null}
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
          {doc.data.updated} · Confidential, shared under invitation.
        </footer>
      </main>
    </div>
  );
}
