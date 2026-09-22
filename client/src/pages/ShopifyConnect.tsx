import { useLocation, useSearch } from "wouter";
import { CheckCircle2, ChevronRight, Mail, ShieldCheck, TriangleAlert } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ShopifyWelcome() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const { user, loading } = useAuth();
  const params = new URLSearchParams(search);
  const shop = params.get("shop") ?? "your Shopify store";
  const emailStatus = params.get("email") ?? "pending";
  const connection = trpc.shopifyConnector.listStores.useQuery({}, {
    enabled: Boolean(user),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const store = connection.data?.find((item) => item.shopDomain === shop);

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Preparing your Shopify connection…</div>;
  }

  if (!user) {
    return (
      <Shell>
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
          <CheckCircle2 className="h-10 w-10 text-emerald-600" />
        </div>
        <CardTitle className="text-2xl text-[#1B365D]">Shopify connection secured</CardTitle>
        <CardDescription className="text-base leading-relaxed">
          ReconcileAI has connected to <strong>{shop}</strong> with read-only order access. No orders, payments, refunds or store settings were changed.
        </CardDescription>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-left text-sm text-slate-700">
          <div className="flex gap-3">
            <Mail className="mt-0.5 h-5 w-5 shrink-0 text-[#F47458]" />
            <div>
              <p className="font-semibold">Confirm your ReconcileAI administrator account</p>
              <p className="mt-1 text-slate-600">
                {emailStatus === "sent"
                  ? "A secure, one-time sign-in link was sent to the contact email configured for this Shopify store. Open it to finish activation."
                  : "The connection is saved, but the administrator invitation is still being prepared. Contact support if the sign-in email does not arrive."}
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-lg bg-blue-50 p-4 text-left text-sm text-blue-900">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
            <p>Initial permission: read-only order and transaction evidence from Shopify’s standard 60-day window. ReconcileAI cannot initiate payments, refunds or store changes.</p>
          </div>
        </div>
      </Shell>
    );
  }

  const connectionText = connection.isLoading
    ? "Checking the secured connection…"
    : store?.status === "active"
      ? "Your Shopify store is connected to this ReconcileAI workspace."
      : store?.status === "reauthorization_required" || store?.status === "uninstalled"
        ? "This store is not currently connected. Reinstall ReconcileAI from Shopify, or contact support if that does not restore it."
        : "The store connection is being confirmed. Refresh this page in a moment if it does not appear.";

  return (
    <Shell>
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
        <CheckCircle2 className="h-10 w-10 text-emerald-600" />
      </div>
      <CardTitle className="text-2xl text-[#1B365D]">Administrator account confirmed</CardTitle>
      <CardDescription className="text-base leading-relaxed">{connectionText}</CardDescription>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-left text-sm text-amber-950">
        <div className="flex gap-3">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <p><strong>Development foundation:</strong> this release secures the install, token lifecycle and privacy-webhook boundary. The next reviewed release enables the order-led sync and reconciliation workspace; it is not yet a production App Store submission.</p>
        </div>
      </div>
      <Button className="w-full bg-[#1B365D] hover:bg-[#102A43]" onClick={() => navigate("/settlement-monitor")}>
        Open ReconcileAI workspace <ChevronRight className="ml-2 h-4 w-4" />
      </Button>
    </Shell>
  );
}

export function ShopifyError() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const reason = new URLSearchParams(search).get("reason") ?? "install_failed";
  const message: Record<string, string> = {
    invalid_shop: "The Shopify store address is not valid. Restart installation from Shopify.",
    security_check_failed: "The Shopify security check could not be completed. Restart installation from Shopify.",
    expired_or_replayed: "This installation session expired or was already used. Restart installation from Shopify.",
    required_permissions_not_granted: "ReconcileAI needs read-only order access to continue. No Shopify data was changed.",
    not_configured: "The ReconcileAI Shopify connector is not yet configured for this environment.",
    ownership_verification_required:
      "This store is already connected to a ReconcileAI workspace, and its current contact email does not match that workspace's administrator. For your protection the connection was not transferred. Contact ReconcileAI support to verify ownership.",
    email_already_registered:
      "This store's contact email already belongs to another ReconcileAI workspace, so a new workspace could not be created for it. Contact ReconcileAI support to connect this store.",
    missing_contact_email:
      "Shopify did not provide a contact email for this store. Add a store contact email in Shopify settings, then restart installation.",
    store_identity_conflict:
      "This store's details conflict with an existing connection, so it was not connected. Contact ReconcileAI support.",
    temporarily_unavailable: "ReconcileAI is temporarily unavailable. Please restart installation from Shopify in a few minutes.",
  };
  return (
    <Shell>
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
        <TriangleAlert className="h-9 w-9 text-red-600" />
      </div>
      <CardTitle className="text-2xl text-[#1B365D]">Shopify connection not completed</CardTitle>
      <CardDescription className="text-base leading-relaxed">{message[reason] ?? "We could not finish the secure Shopify connection. No changes were made to your store."}</CardDescription>
      <Button variant="outline" className="w-full" onClick={() => navigate("/")}>Return to ReconcileAI</Button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-blue-50 p-4">
      <Card className="w-full max-w-xl border-slate-200 shadow-xl">
        <CardHeader className="space-y-4 text-center">{children}</CardHeader>
        <CardContent />
      </Card>
    </main>
  );
}
