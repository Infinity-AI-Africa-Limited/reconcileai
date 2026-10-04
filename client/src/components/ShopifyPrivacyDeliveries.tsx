import { Download, ShieldCheck } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { privacyDeliveriesToShow, privacyDeliveryQueryOptions } from "@/lib/shopifyPrivacyDeliveries";

/**
 * Customer data-request exports waiting for the store's claiming administrator.
 *
 * Shopify's `customers/data_request` is fulfilled here: the export is prepared
 * in the background, and only the claiming merchant administrator can download
 * it. Renders nothing for anyone else, or when there is nothing to deliver.
 */
export function ShopifyPrivacyDeliveries() {
  const { user } = useAuth();
  const isMerchantAdmin = user?.role === "admin";
  const deliveries = trpc.shopifyConnector.listPrivacyDeliveries.useQuery(
    undefined,
    privacyDeliveryQueryOptions(isMerchantAdmin),
  );
  const rows = privacyDeliveriesToShow(deliveries.data ?? []);
  if (!isMerchantAdmin || rows.length === 0) return null;

  return (
    <Card className="border-amber-200">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-5 w-5 text-amber-600" />
          Customer data requests ready for you
        </CardTitle>
        <CardDescription>
          A Shopify customer asked what data this store holds about them. Download each export and pass it on to the
          customer. Exports are deleted automatically when they expire.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.artifactId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 p-3 text-sm"
          >
            <div className="min-w-0">
              <p className="font-medium">{row.summary}</p>
              <p className="text-muted-foreground">
                {row.expiresInDays > 0 ? `Expires in ${row.expiresInDays} day${row.expiresInDays === 1 ? "" : "s"}` : "Expires today"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {row.delivered ? <Badge variant="secondary">Downloaded</Badge> : <Badge>Waiting</Badge>}
              <Button asChild size="sm" variant={row.delivered ? "outline" : "default"}>
                {/* The server sends the file and records delivery once it has all been sent. */}
                <a href={row.href} download onClick={() => window.setTimeout(() => void deliveries.refetch(), 4_000)}>
                  <Download className="mr-2 h-4 w-4" />
                  Download
                </a>
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
