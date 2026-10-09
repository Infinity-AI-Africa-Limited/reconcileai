import { useLocation, useSearch } from "wouter";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { shopifyInstallErrorMessage } from "@/lib/shopifyConnection";

/**
 * Where a refused Shopify installation lands, outside Shopify Admin. Since the
 * authorization-code path was retired its only sender is that retired path
 * (routes.ts), answering `managed_install_only`; installation and reconnection
 * succeed inside Shopify, in App Home (ShopifyAppHome.tsx).
 */
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
