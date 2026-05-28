import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, CheckCircle2, XCircle, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";

type State = "loading" | "success" | "error";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_magic_link: "The login link is missing or malformed.",
  expired_magic_link: "This login link has already been used or has expired (links are valid for 72 hours).",
  account_inactive: "Your account has been deactivated. Please contact your administrator.",
  login_failed: "An unexpected error occurred during login. Please try again or contact support.",
};

export default function MagicLogin() {
  const [, setLocation] = useLocation();
  const [state, setState] = useState<State>("loading");
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const errorCode = params.get("error");

    // If the backend already redirected here with an error param (shouldn't
    // normally happen since the backend redirects to /?error=..., but handle it)
    if (errorCode) {
      setErrorMsg(ERROR_MESSAGES[errorCode] ?? "An unexpected error occurred.");
      setState("error");
      return;
    }

    if (!token) {
      setErrorMsg(ERROR_MESSAGES.invalid_magic_link);
      setState("error");
      return;
    }

    // Redirect to the backend magic-login endpoint which sets the cookie and
    // redirects to /dashboard on success, or /?error=... on failure.
    // We navigate directly so the browser follows the redirect chain and the
    // session cookie is set correctly.
    window.location.href = `/api/magic-login?token=${encodeURIComponent(token)}`;
  }, []);

  // This page is only briefly visible while the redirect happens.
  // If we reach "error" state it means the token param was missing entirely.
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#1B365D] to-[#0f2240] px-4">
      <div className="bg-white rounded-2xl shadow-2xl p-10 max-w-md w-full text-center space-y-6">
        {/* Logo / Brand */}
        <div className="flex flex-col items-center gap-2">
          <div className="w-14 h-14 rounded-xl bg-[#1B365D] flex items-center justify-center">
            <span className="text-white font-bold text-2xl">R</span>
          </div>
          <h1 className="text-xl font-bold text-[#1B365D]">ReconcileAI</h1>
        </div>

        {state === "loading" && (
          <>
            <Loader2 className="h-10 w-10 text-[#F47458] animate-spin mx-auto" />
            <div>
              <p className="text-lg font-semibold text-gray-800">Signing you in…</p>
              <p className="text-sm text-gray-500 mt-1">
                Please wait while we verify your login link.
              </p>
            </div>
          </>
        )}

        {state === "success" && (
          <>
            <CheckCircle2 className="h-10 w-10 text-green-500 mx-auto" />
            <div>
              <p className="text-lg font-semibold text-gray-800">Login successful!</p>
              <p className="text-sm text-gray-500 mt-1">Redirecting you to the dashboard…</p>
            </div>
          </>
        )}

        {state === "error" && (
          <>
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center">
                {errorMsg.includes("deactivated") ? (
                  <ShieldAlert className="h-8 w-8 text-red-500" />
                ) : (
                  <XCircle className="h-8 w-8 text-red-500" />
                )}
              </div>
              <p className="text-lg font-semibold text-gray-800">Login link invalid</p>
              <p className="text-sm text-gray-500 leading-relaxed">{errorMsg}</p>
            </div>
            <div className="flex flex-col gap-3 pt-2">
              <Button
                className="w-full bg-[#1B365D] hover:bg-[#152a4a] text-white"
                onClick={() => (window.location.href = getLoginUrl())}
              >
                Sign in with Manus
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setLocation("/")}
              >
                Back to home
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
