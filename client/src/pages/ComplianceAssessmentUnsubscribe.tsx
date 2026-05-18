import { useEffect, useState } from "react";
import { useRoute, Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Shield, CheckCircle2, AlertTriangle, ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ComplianceAssessmentUnsubscribe() {
  const [, params] = useRoute("/compliance-assessment/unsubscribe/:token");
  const token = params?.token ?? "";

  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const unsubscribeMutation = trpc.assessment.unsubscribe.useMutation({
    onSuccess: () => setStatus("success"),
    onError: (err) => {
      setStatus("error");
      setErrorMsg(err.message ?? "Something went wrong. Please try again.");
    },
  });

  useEffect(() => {
    if (token && token.length === 48) {
      unsubscribeMutation.mutate({ token });
    } else {
      setStatus("error");
      setErrorMsg("Invalid unsubscribe link. Please check the link in your email.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Nav */}
      <nav className="bg-white border-b border-gray-200 px-6 py-4">
        <Link href="/">
          <span className="text-lg font-bold text-[#1B365D] cursor-pointer">ReconcileAI</span>
        </Link>
      </nav>

      <div className="flex-1 flex items-center justify-center px-4 py-16">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-10 max-w-md w-full text-center">
          {status === "loading" && (
            <>
              <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-6">
                <Loader2 className="h-8 w-8 text-gray-400 animate-spin" />
              </div>
              <h1 className="text-xl font-bold text-[#1B365D] mb-2">Processing your request…</h1>
              <p className="text-sm text-gray-500">Please wait a moment.</p>
            </>
          )}

          {status === "success" && (
            <>
              <div className="w-16 h-16 rounded-full bg-emerald-50 flex items-center justify-center mx-auto mb-6">
                <CheckCircle2 className="h-8 w-8 text-emerald-600" />
              </div>
              <h1 className="text-xl font-bold text-[#1B365D] mb-3">You've been unsubscribed</h1>
              <p className="text-sm text-gray-600 leading-relaxed mb-2">
                You will no longer receive follow-up or demo invitation emails from ReconcileAI regarding this assessment.
              </p>
              <p className="text-xs text-gray-400 mb-8">
                This preference has been saved in compliance with Nigeria's NDPR. If you change your mind, you can always complete a new assessment and opt in again.
              </p>
              <div className="flex flex-col gap-3">
                <Link href="/compliance-assessment">
                  <Button className="w-full bg-[#1B365D] hover:bg-[#1B365D]/90 text-white">
                    Take a New Assessment
                  </Button>
                </Link>
                <Link href="/">
                  <Button variant="outline" className="w-full">
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back to Home
                  </Button>
                </Link>
              </div>
            </>
          )}

          {status === "error" && (
            <>
              <div className="w-16 h-16 rounded-full bg-orange-50 flex items-center justify-center mx-auto mb-6">
                <AlertTriangle className="h-8 w-8 text-orange-500" />
              </div>
              <h1 className="text-xl font-bold text-[#1B365D] mb-3">Unable to process request</h1>
              <p className="text-sm text-gray-600 leading-relaxed mb-8">{errorMsg}</p>
              <div className="flex flex-col gap-3">
                <Link href="/">
                  <Button variant="outline" className="w-full">
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back to Home
                  </Button>
                </Link>
              </div>
            </>
          )}

          {/* NDPR notice */}
          <div className="mt-8 pt-6 border-t border-gray-100 flex items-start gap-2 text-left">
            <Shield className="h-4 w-4 text-gray-300 mt-0.5 shrink-0" />
            <p className="text-xs text-gray-400 leading-relaxed">
              ReconcileAI processes your data in accordance with Nigeria's Data Protection Regulation (NDPR) and the NDPR Implementation Framework. For data requests, contact{" "}
              <a href="mailto:privacy@reconcileai.vip" className="underline">privacy@reconcileai.vip</a>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
