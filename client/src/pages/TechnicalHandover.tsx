/**
 * Technical Handover & Architecture — a privately-shared, read-only web page.
 *
 * Gated by <PocAccessGate pocKey="technical_handover"> at the route level (same
 * invite-link mechanism as the POC pages: `?key=<token>`), so it is only viewable
 * with an invitation link generated from the POC Hub.
 *
 * Content source: `client/src/content/technicalHandover.md` (a presentation copy
 * of `docs/TECHNICAL_HANDOVER.md`; the repo doc keeps its Mermaid diagrams, this
 * copy uses plain-text diagrams so it renders without a Mermaid dependency).
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ShieldCheck } from "lucide-react";
import handoverMd from "@/content/technicalHandover.md?raw";

export default function TechnicalHandover() {
  return (
    // Copy-deter: block text selection, copy/cut, and the right-click menu. This
    // is a deterrent for casual copying, not real protection — the text still
    // lives in the DOM and can be extracted by technical means.
    <div
      className="min-h-screen bg-gray-50 text-gray-900 select-none"
      onCopy={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <header className="sticky top-0 z-10 border-b border-white/10 bg-[#1B365D] text-white">
        <div className="mx-auto flex max-w-4xl items-center gap-4 px-6 py-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-white/80" />
            <div className="leading-tight">
              <p className="text-sm font-semibold">ReconcileAI — Technical Handover</p>
              <p className="text-[11px] text-white/70">Confidential · shared by invitation</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10">
        <article
          className="prose prose-slate max-w-none
            prose-headings:text-[#1B365D] prose-a:text-[#F4758C] prose-strong:text-[#1B365D]
            prose-pre:overflow-x-auto prose-pre:text-[12.5px] prose-pre:leading-snug
            prose-table:text-sm prose-th:text-[#1B365D] prose-code:text-[#1B365D]"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
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
            {handoverMd}
          </ReactMarkdown>
        </article>
      </main>

      <footer className="border-t bg-white py-6">
        <p className="mx-auto max-w-4xl px-6 text-center text-xs text-muted-foreground">
          Confidential — Infinity AI Africa Limited. Shared privately by invitation; please do not redistribute.
        </p>
      </footer>
    </div>
  );
}
