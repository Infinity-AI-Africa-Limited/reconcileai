/**
 * Public support page for ReconcileAI's Shopify Scope A app.
 * Accessible at /support without authentication.
 */
import { BookOpen, Mail, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Support() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container max-w-4xl py-16">
        <h1 className="text-3xl font-bold mb-2">ReconcileAI Support</h1>
        <p className="text-muted-foreground mb-8">
          Help for the read-only Shopify Scope A reconciliation workspace.
        </p>

        <div className="grid grid-cols-1 gap-6 mb-12 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Mail className="h-5 w-5 text-primary" />
                Contact support
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-2 text-sm text-muted-foreground">
                Include your Shopify store domain and a short description of the issue. Do not send order files, customer data,
                API tokens, or screenshots containing sensitive data by email.
              </p>
              <a href="mailto:support@reconcileaiafrica.com" className="text-sm font-medium text-primary underline">
                support@reconcileaiafrica.com
              </a>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <ShieldCheck className="h-5 w-5 text-primary" />
                Scope A boundary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                ReconcileAI reads limited Shopify order evidence. It does not edit Shopify records, issue refunds, move funds,
                post to a ledger, or access Shopify Payments payouts and fees in this release.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <BookOpen className="h-5 w-5 text-primary" />
                Before contacting us
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Confirm that you are in the correct Shopify store, that the app remains installed, and that your settlement export
                includes an order reference, amount, currency, and settlement date.
              </p>
            </CardContent>
          </Card>
        </div>

        <section className="mb-12">
          <h2 className="mb-6 text-2xl font-semibold">Frequently asked questions</h2>
          <div className="space-y-6">
            <div>
              <h3 className="mb-2 font-medium">What does ReconcileAI access from Shopify?</h3>
              <p className="text-sm text-muted-foreground">
                Scope A uses Shopify&apos;s <code>read_orders</code> permission to read recent order and refund evidence needed for
                reconciliation. It does not have write permissions, and it does not connect to Shopify Payments payouts or fees.
              </p>
            </div>

            <div>
              <h3 className="mb-2 font-medium">How do I reconcile a settlement?</h3>
              <p className="text-sm text-muted-foreground">
                In the embedded ReconcileAI workspace, first request a refresh of your recent Shopify order evidence. Then upload
                a settlement, payout, payment-provider, or courier export that you obtained from your provider. Review the
                detected column mapping before importing the evidence.
              </p>
            </div>

            <div>
              <h3 className="mb-2 font-medium">Does ReconcileAI change my Shopify store or move money?</h3>
              <p className="text-sm text-muted-foreground">
                No. ReconcileAI is read-only in Scope A. It presents evidence, matches, and differences for human review; it does
                not modify orders, issue refunds, initiate payments, or make a financial decision for you.
              </p>
            </div>

            <div>
              <h3 className="mb-2 font-medium">Is the app paid?</h3>
              <p className="text-sm text-muted-foreground">
                Scope A is available without charge at launch. Shopify billing is not used for this release.
              </p>
            </div>

            <div>
              <h3 className="mb-2 font-medium">How do I stop access or request deletion?</h3>
              <p className="text-sm text-muted-foreground">
                You can uninstall ReconcileAI from Shopify to stop the app&apos;s access. For a data-rights request, email support with
                your store domain and the type of request. See the <a href="/privacy" className="text-primary underline">Privacy Notice</a>{" "}
                for the handling process.
              </p>
            </div>

            <div>
              <h3 className="mb-2 font-medium">What should I avoid sending to support?</h3>
              <p className="text-sm text-muted-foreground">
                Never send access tokens, passwords, full payment credentials, raw Shopify webhook bodies, or customer personal
                data. We will ask for a safe, minimum-data diagnostic path if investigation is needed.
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-2xl font-semibold">Useful links</h2>
          <p className="text-sm text-muted-foreground">
            Read our <a href="/privacy" className="text-primary underline">Privacy Notice</a> and{" "}
            <a href="/terms" className="text-primary underline">Terms of Service</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
