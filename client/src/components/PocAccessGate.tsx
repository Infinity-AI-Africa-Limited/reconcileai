/**
 * Lightweight access gate for public POC pages.
 *
 * Reads the access token from the link (`?key=…`), stores it so the tRPC client
 * sends it on every request (x-poc-access-token header), and verifies it with
 * the server before rendering the POC. If the token is missing/invalid, it shows
 * an "enter access code" screen instead. Server-side procedures are also gated,
 * so this is UX — not the security boundary.
 */
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Loader2, Lock, ShieldCheck } from "lucide-react";

const STORAGE_KEY = "poc_access_token";

function readKeyFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("key");
  } catch {
    return null;
  }
}

export default function PocAccessGate({
  pocKey,
  children,
  title = "Protected POC",
  subtitle = "This proof-of-concept is invite-only. Enter the access code from your invitation link to continue.",
}: {
  pocKey: string;
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
}) {
  // Seed from the URL (?key=) once, falling back to any token already stored.
  const initial = useMemo(() => readKeyFromUrl() ?? sessionStorage.getItem(STORAGE_KEY) ?? "", []);
  const [token, setToken] = useState(initial);
  const [codeInput, setCodeInput] = useState("");

  // Keep the stored token in sync so the tRPC header reflects the current value.
  useEffect(() => {
    try {
      if (token) sessionStorage.setItem(STORAGE_KEY, token);
    } catch {
      /* ignore */
    }
  }, [token]);

  const check = trpc.poc.checkAccess.useQuery(
    { pocKey, accessToken: token || undefined },
    { retry: false, refetchOnWindowFocus: false },
  );

  if (check.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (check.data?.valid) {
    return <>{children}</>;
  }

  // Locked — ask for the access code.
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setToken(codeInput.trim());
  };
  const triedAndFailed = !!token && check.data && !check.data.valid;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-6">
      <div className="w-full max-w-sm rounded-2xl border bg-white p-8 shadow-sm text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Lock className="h-6 w-6 text-primary" />
        </div>
        <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {subtitle}
        </p>
        <form onSubmit={submit} className="mt-5 space-y-3">
          <input
            type="text"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            placeholder="Access code"
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            autoFocus
          />
          {triedAndFailed && (
            <p className="text-xs text-red-600">That access code isn't valid for this POC.</p>
          )}
          <button
            type="submit"
            className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Unlock
          </button>
        </form>
        <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3 w-3" /> Don't have a code? Ask your ReconcileAI contact for an access link.
        </p>
      </div>
    </div>
  );
}
