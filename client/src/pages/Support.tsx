/**
 * Support page — required for SHOPLINE App Store listing.
 * Accessible at /support (public, no auth required).
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Mail, MessageCircle, BookOpen, Clock } from "lucide-react";

export default function Support() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container max-w-4xl py-16">
        <h1 className="text-3xl font-bold mb-2">Support</h1>
        <p className="text-muted-foreground mb-8">
          Get help with ReconcileAI — we&apos;re here to ensure your reconciliation runs smoothly.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Mail className="h-5 w-5 text-primary" />
                Email Support
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-2">
                For technical issues, billing questions, or account inquiries.
              </p>
              <a
                href="mailto:support@reconcileaiafrica.com"
                className="text-primary underline text-sm font-medium"
              >
                support@reconcileaiafrica.com
              </a>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Clock className="h-5 w-5 text-primary" />
                Response Times
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                <strong>Starter/Growth:</strong> Within 24 hours<br />
                <strong>Professional:</strong> Within 12 hours<br />
                <strong>Scale/Enterprise:</strong> Within 4 hours
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <BookOpen className="h-5 w-5 text-primary" />
                Documentation
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-2">
                Guides, FAQs, and API documentation for self-service help.
              </p>
              <a
                href="https://www.reconcileaiafrica.com/docs"
                className="text-primary underline text-sm font-medium"
              >
                View Documentation
              </a>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <MessageCircle className="h-5 w-5 text-primary" />
                Feature Requests
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-2">
                Have an idea for improving ReconcileAI? We&apos;d love to hear it.
              </p>
              <a
                href="mailto:feedback@reconcileaiafrica.com"
                className="text-primary underline text-sm font-medium"
              >
                feedback@reconcileaiafrica.com
              </a>
            </CardContent>
          </Card>
        </div>

        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-6">Frequently Asked Questions</h2>

          <div className="space-y-6">
            <div>
              <h3 className="font-medium mb-2">How do I connect my SHOPLINE store?</h3>
              <p className="text-sm text-muted-foreground">
                ReconcileAI connects automatically when you install it from the SHOPLINE App Store.
                Simply click &quot;Install&quot;, authorize the requested permissions, and your store data
                will begin syncing within minutes.
              </p>
            </div>

            <div>
              <h3 className="font-medium mb-2">How often does reconciliation run?</h3>
              <p className="text-sm text-muted-foreground">
                ReconcileAI processes transactions in real-time via webhooks. Additionally,
                a full reconciliation sweep runs every 15 minutes to catch any missed events,
                and a comprehensive daily batch ensures complete coverage.
              </p>
            </div>

            <div>
              <h3 className="font-medium mb-2">What happens if I exceed my plan&apos;s order limit?</h3>
              <p className="text-sm text-muted-foreground">
                You&apos;ll receive a notification when you reach 80% of your monthly order limit.
                If you exceed the limit, reconciliation continues but you&apos;ll be prompted to
                upgrade to the next tier. We never stop processing mid-month.
              </p>
            </div>

            <div>
              <h3 className="font-medium mb-2">Can I connect multiple stores?</h3>
              <p className="text-sm text-muted-foreground">
                Yes! The number of stores you can connect depends on your plan tier.
                Starter supports 1 store, Growth supports 3, Professional supports 10,
                Scale supports 50, and Enterprise is unlimited.
              </p>
            </div>

            <div>
              <h3 className="font-medium mb-2">How do I cancel my subscription?</h3>
              <p className="text-sm text-muted-foreground">
                You can cancel at any time by uninstalling ReconcileAI from your SHOPLINE
                App Store. Your data will be retained for 90 days in case you want to
                reinstall, after which it is permanently deleted.
              </p>
            </div>

            <div>
              <h3 className="font-medium mb-2">Is my financial data secure?</h3>
              <p className="text-sm text-muted-foreground">
                Absolutely. All data is encrypted in transit (TLS 1.3) and at rest (AES-256).
                Access tokens are stored using envelope encryption. We are GDPR and POPIA
                compliant. See our{" "}
                <a href="/privacy" className="text-primary underline">Privacy Policy</a>{" "}
                for full details.
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">Service Status</h2>
          <p className="text-sm text-muted-foreground">
            Check the current status of ReconcileAI services at{" "}
            <a
              href="https://status.reconcileaiafrica.com"
              className="text-primary underline"
            >
              status.reconcileaiafrica.com
            </a>
          </p>
        </section>
      </div>
    </div>
  );
}
