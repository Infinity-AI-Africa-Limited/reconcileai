/**
 * Technical Handover & Architecture — privately-shared document page.
 *
 * Mounted behind <PocAccessGate pocKey="technical_handover">, so it is reachable
 * only with an invite link (`/technical-handover?key=…`) issued from the POC Hub.
 * The document body is fetched from the access-gated `poc.handover` procedure
 * rather than bundled into the client, so the private link is a real boundary:
 * the text is never in a JS chunk and cannot be read without a valid token.
 *
 * Read-only presentation: text selection, copy/cut, the context menu, drag and
 * the print/save shortcuts are suppressed, and the page is blanked in print
 * media. Treat this as deterrence, not protection — anything rendered in a
 * browser can still be read from devtools, the network response, or a photo of
 * the screen. The access token remains the actual control.
 */
import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { trpc } from "@/lib/trpc";
import { Loader2, Lock, ShieldCheck } from "lucide-react";

const POC_KEY = "technical_handover";

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

// Suppress selection/callout on screen, and blank the document for print so
// Ctrl+P / "Save as PDF" yields a confidentiality notice rather than the text.
const PROTECTION_CSS = `
.th-protected, .th-protected * {
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

export default function TechnicalHandover() {
  const doc = trpc.poc.handover.useQuery(
    { pocSlug: POC_KEY },
    { refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 },
  );

  // Block copy/cut/context-menu/drag and the print/save/select shortcuts while
  // this page is mounted. Listeners are attached in the capture phase so page
  // content cannot opt out, and are removed on unmount so the rest of the app
  // behaves normally.
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
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="h-6 w-6 animate-spin text-[#1B365D]" />
      </div>
    );
  }

  if (doc.error || !doc.data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-6">
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
    <div className="th-protected relative min-h-screen bg-gray-50 text-gray-900">
      <style>{PROTECTION_CSS}</style>

      {/* Attribution watermark — sits above the content, ignores pointer events. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-50 select-none"
        style={watermarkStyle(stamp)}
      />

      <header className="sticky top-0 z-10 border-b border-white/10 bg-[#1B365D] text-white">
        <div className="mx-auto flex max-w-4xl items-center gap-4 px-6 py-3">
          <ShieldCheck className="h-5 w-5 text-white/80" />
          <div className="leading-tight">
            <p className="text-sm font-semibold">ReconcileAI — Technical Handover</p>
            <p className="text-[11px] text-white/70">Confidential · shared by invitation</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-8 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900">
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

        <article
          className="prose prose-slate max-w-none
            prose-headings:text-[#1B365D] prose-a:text-[#F4758C] prose-strong:text-[#1B365D]
            prose-pre:overflow-x-auto prose-pre:text-[12.5px] prose-pre:leading-snug
            prose-table:text-sm prose-th:text-[#1B365D] prose-code:text-[#1B365D]"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Tables can be wider than the column — scroll each in its own
              // container so the page body never scrolls sideways.
              table: ({ children }) => (
                <div className="overflow-x-auto">
                  <table>{children}</table>
                </div>
              ),
              // External URLs open in a new tab; repo-relative references (e.g.
              // "server/routers.ts") aren't reachable from this page, so render
              // them as inline code rather than broken links.
              a: ({ href, children }) => {
                const isExternal = !!href && /^https?:\/\//.test(href);
                return isExternal ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ) : (
                  <code>{children}</code>
                );
              },
            }}
          >
            {doc.data.markdown}
          </ReactMarkdown>
        </article>

        <footer className="mt-14 border-t pt-6 text-xs text-muted-foreground">
          Confidential — Infinity AI Africa Limited · {doc.data.updated} · shared under invitation;
          please do not redistribute.
        </footer>
      </main>
    </div>
  );
}
