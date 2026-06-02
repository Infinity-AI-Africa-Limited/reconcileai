import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Loader2, Mail, CheckCircle2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Login() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // If the user is already signed in, skip the login page.
  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

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
