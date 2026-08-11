/**
 * SHOPLINE Connect — Install Landing & Welcome Page
 *
 * This page serves two purposes:
 * 1. /shopline/welcome — Post-install welcome screen after successful OAuth
 * 2. /shopline/error — Error screen if install fails
 *
 * The welcome screen shows:
 * - Success confirmation
 * - What happens next (auto-sync, reconciliation)
 * - Link to the dashboard
 * - First sync status (if available)
 */
import { useLocation, useSearch } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, ArrowRight, RefreshCw, Shield, Zap } from "lucide-react";
import { landingPathFor } from "@/lib/routeAccess";

export function ShoplineWelcome() {
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const orgCode = params.get("org") || "";
  const isReconnection = params.get("reconnect") === "true";
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <CheckCircle2 className="h-10 w-10 text-green-600" />
          </div>
          <CardTitle className="text-2xl">
            {isReconnection ? "Store Reconnected!" : "Store Connected Successfully!"}
          </CardTitle>
          <CardDescription className="text-base mt-2">
            {isReconnection
              ? "Your SHOPLINE store has been reconnected to ReconcileAI. All sync schedules have been restored."
              : "Your SHOPLINE store is now connected to ReconcileAI. We'll start reconciling your transactions automatically."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* What happens next */}
          <div className="space-y-3">
            <h3 className="font-semibold text-sm text-slate-700 uppercase tracking-wide">
              What happens next
            </h3>
            <div className="space-y-2">
              <div className="flex items-start gap-3">
                <RefreshCw className="h-5 w-5 text-blue-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Automatic Sync</p>
                  <p className="text-xs text-muted-foreground">
                    We'll sync your orders, payments, and payouts every 15 minutes.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Zap className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Instant Reconciliation</p>
                  <p className="text-xs text-muted-foreground">
                    Transactions are matched automatically using our three-leg join engine.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Shield className="h-5 w-5 text-purple-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Exception Detection</p>
                  <p className="text-xs text-muted-foreground">
                    Chargebacks, fee variances, and settlement shortfalls are flagged instantly.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Organization code */}
          {orgCode && (
            <div className="rounded-md bg-slate-50 p-3 border">
              <p className="text-xs text-muted-foreground">Organization Code</p>
              <p className="text-sm font-mono font-medium">{orgCode}</p>
            </div>
          )}

          {/* CTA */}
          <div className="flex flex-col gap-2">
            {/* Straight to Settlement Monitor, not the dashboard. This screen is
                only ever shown to a SHOPLINE merchant, and their next question is
                "did my payout land" — which is the monitor, not the operator's
                reconciliation overview. Derived from landingPathFor rather than
                hardcoded so it follows if retail's landing page ever moves. */}
            <Button
              className="w-full"
              onClick={() => navigate(landingPathFor("retail_commerce"))}
            >
              Go to Settlement Monitor
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => navigate("/channels")}
            >
              View Connected Channels
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function ShoplineError() {
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const reason = params.get("reason") || "unknown";
  const [, navigate] = useLocation();

  const errorMessages: Record<string, { title: string; description: string }> = {
    install_failed: {
      title: "Installation Failed",
      description:
        "We couldn't complete the connection to your SHOPLINE store. This may be due to insufficient permissions or a temporary issue.",
    },
    invalid_signature: {
      title: "Security Verification Failed",
      description:
        "The request signature could not be verified. Please try installing again from the SHOPLINE App Store.",
    },
    token_expired: {
      title: "Session Expired",
      description:
        "Your authorization session has expired. Please try installing again from the SHOPLINE App Store.",
    },
    unknown: {
      title: "Something Went Wrong",
      description:
        "An unexpected error occurred during installation. Please try again or contact support.",
    },
  };

  const error = errorMessages[reason] || errorMessages.unknown;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-red-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <XCircle className="h-10 w-10 text-red-600" />
          </div>
          <CardTitle className="text-2xl">{error.title}</CardTitle>
          <CardDescription className="text-base mt-2">
            {error.description}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md bg-red-50 p-3 border border-red-100">
            <p className="text-xs text-muted-foreground">Error Code</p>
            <p className="text-sm font-mono">{reason}</p>
          </div>

          <div className="flex flex-col gap-2">
            <Button
              className="w-full"
              onClick={() => {
                // Redirect back to SHOPLINE App Store
                window.location.href = "https://apps.myshopline.com";
              }}
            >
              Try Again from App Store
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => navigate("/")}
            >
              Return to Home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
