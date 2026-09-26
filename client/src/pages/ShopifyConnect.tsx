import { useLocation, useSearch } from "wouter";
import { CheckCircle2, ChevronRight, LoaderCircle, Mail, ShieldCheck, TriangleAlert } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SHOPIFY_CONNECTION_MESSAGES, shopifyConnectionVerdict, shopifyInstallErrorMessage } from "@/lib/shopifyConnection";
import { ShopifyPrivacyDeliveries } from "@/components/ShopifyPrivacyDeliveries";

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
  const syncOrders = trpc.shopifyConnector.syncOrdersNow.useMutation();
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
          ReconcileAI Dev Store has connected to <strong>{shop}</strong> with read-only order access. No orders, payments, refunds or store settings were changed.
        </CardDescription>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-left text-sm text-slate-700">
          <div className="flex gap-3">
            <Mail className="mt-0.5 h-5 w-5 shrink-0 text-[#F47458]" />
            <div>
              <p className="font-semibold">Confirm your ReconcileAI Dev Store administrator account</p>
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
            <p>Initial permission: read-only order and transaction evidence from Shopify’s standard 60-day window. ReconcileAI Dev Store cannot initiate payments, refunds or store changes.</p>
          </div>
        </div>
      </Shell>
    );
  }

  const connectionText = SHOPIFY_CONNECTION_MESSAGES[
    shopifyConnectionVerdict({ isLoading: connection.isLoading, status: store?.status })
  ];

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
          <p><strong>Development release:</strong> use the first read-only order sync below to retrieve the most recent 24-hour order window. ReconcileAI Dev Store does not change Shopify orders, payments, refunds or settings. App Store submission remains subject to separate privacy-completion, developer-store and reviewer-evidence gates.</p>
          </div>
        </div>
        {store?.status === "active" ? (
          <div className="space-y-2">
            <Button
              className="w-full bg-[#F47458] hover:bg-[#dd5e45]"
              disabled={syncOrders.isPending}
              onClick={() => syncOrders.mutate({ storeId: store.id })}
            >
              {syncOrders.isPending ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
              Sync recent Shopify order evidence
            </Button>
            {syncOrders.isSuccess ? (
              <p className="rounded-md bg-emerald-50 p-3 text-center text-sm text-emerald-800">
                Sync complete: {syncOrders.data.inserted} new, {syncOrders.data.updated} updated and {syncOrders.data.unchanged} unchanged order record(s).
              </p>
            ) : null}
            {syncOrders.isError ? (
              <p className="rounded-md bg-red-50 p-3 text-center text-sm text-red-800">
                The order sync could not complete. Reconnect the Shopify store or contact support.
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="text-left">
          <ShopifyPrivacyDeliveries />
        </div>
        <Button className="w-full bg-[#1B365D] hover:bg-[#102A43]" onClick={() => navigate("/settlement-monitor")}>
          Open ReconcileAI Dev Store workspace <ChevronRight className="ml-2 h-4 w-4" />
      </Button>
    </Shell>
  );
}

export function ShopifyError() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const message = shopifyInstallErrorMessage(new URLSearchParams(search).get("reason"));
  return (
    <Shell>
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
        <TriangleAlert className="h-9 w-9 text-red-600" />
      </div>
      <CardTitle className="text-2xl text-[#1B365D]">Shopify connection not completed</CardTitle>
      <CardDescription className="text-base leading-relaxed">{message}</CardDescription>
      <Button variant="outline" className="w-full" onClick={() => navigate("/")}>Return to ReconcileAI Dev Store</Button>
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
