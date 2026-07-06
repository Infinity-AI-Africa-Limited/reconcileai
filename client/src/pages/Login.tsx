import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Loader2, Mail, CheckCircle2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SSO_ERROR_MESSAGES: Record<string, string> = {
  no_account:
    "No ReconcileAI account exists for that email. Ask your organisation's administrator for an invite.",
  org_suspended: "Your organisation's access is currently suspended. Contact ReconcileAI support.",
  sso_cancelled: "Sign-in was cancelled.",
  sso_state_mismatch: "Sign-in session expired — please try again.",
  sso_not_configured: "That sign-in method is not enabled.",
  sso_failed: "Sign-in failed. Please try again or use an email link.",
};

export default function Login() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // If the user is already signed in, skip the login page.
  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Enterprise SSO buttons appear only for providers configured on the server.
  const providersQuery = trpc.auth.oauthProviders.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const ssoProviders = providersQuery.data ?? [];

  // Surface SSO callback errors (?error=...) once, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (err) {
      toast.error(SSO_ERROR_MESSAGES[err] ?? "Sign-in failed. Please try again.");
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!meQuery.isLoading && meQuery.data) {
      setLocation("/dashboard");
    }
  }, [meQuery.isLoading, meQuery.data, setLocation]);

  const requestLink = trpc.auth.requestMagicLink.useMutation({
    onSuccess: () => setSubmitted(true),
    onError: () => {
      // The backend always returns success; this only fires on a network error.
      toast.error("Couldn't reach the server. Please try again.");
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmed)) {
      toast.error("Please enter a valid email address.");
      return;
    }
    requestLink.mutate({ email: trimmed, origin: window.location.origin });
  };

  const sending = requestLink.isPending;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#1B365D] to-[#0f2240] px-4">
      <div className="bg-white rounded-2xl shadow-2xl p-10 max-w-md w-full space-y-6">
        {/* Logo / Brand */}
        <div className="flex flex-col items-center gap-2">
          <div className="w-14 h-14 rounded-xl bg-[#1B365D] flex items-center justify-center">
            <span className="text-white font-bold text-2xl">R</span>
          </div>
          <h1 className="text-xl font-bold text-[#1B365D]">ReconcileAI</h1>
        </div>

        {submitted ? (
          <div className="text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
            <div>
              <p className="text-lg font-semibold text-gray-800">Check your inbox</p>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                If <span className="font-medium text-gray-700">{email.trim().toLowerCase()}</span> is
                registered, we've sent a one-time sign-in link. It's valid for 72 hours.
              </p>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setSubmitted(false);
                setEmail("");
              }}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Use a different email
            </Button>
          </div>
        ) : (
          <>
            <div className="text-center">
              <p className="text-lg font-semibold text-gray-800">Sign in</p>
              <p className="text-sm text-gray-500 mt-1">
                Enter your email and we'll send you a secure sign-in link — no password needed.
              </p>
            </div>

            {ssoProviders.length > 0 && (
              <div className="space-y-3">
                {ssoProviders.map((p) => (
                  <Button
                    key={p.id}
                    type="button"
                    variant="outline"
                    className="w-full font-medium"
                    onClick={() => {
                      window.location.href = `/api/oauth/${p.id}/start`;
                    }}
                  >
                    {p.id === "google" ? (
                      <svg className="h-4 w-4 mr-2" viewBox="0 0 24 24" aria-hidden="true">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
                        <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.77.43 3.45 1.18 4.94l3.66-2.84z" />
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4 mr-2" viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="1" y="1" width="10.5" height="10.5" fill="#F25022" />
                        <rect x="12.5" y="1" width="10.5" height="10.5" fill="#7FBA00" />
                        <rect x="1" y="12.5" width="10.5" height="10.5" fill="#00A4EF" />
                        <rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#FFB900" />
                      </svg>
                    )}
                    Continue with {p.label}
                  </Button>
                ))}
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-gray-200" />
                  <span className="text-xs text-gray-400">or use an email link</span>
                  <div className="h-px flex-1 bg-gray-200" />
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoFocus
                  placeholder="you@yourbank.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={sending}
                  className="pl-10"
                />
              </div>
              <Button
                type="submit"
                disabled={sending}
                className="w-full bg-[#1B365D] hover:bg-[#152a4a] text-white"
              >
                {sending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Sending…
                  </>
                ) : (
                  "Send me a sign-in link"
                )}
              </Button>
            </form>

            <p className="text-xs text-gray-400 text-center leading-relaxed">
              By signing in you agree to ReconcileAI's terms of service. Need access?
              Contact your organisation's administrator.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
