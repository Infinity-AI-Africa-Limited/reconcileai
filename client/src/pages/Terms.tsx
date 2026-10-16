/**
 * Public terms for ReconcileAI's Shopify Scope A app.
 * Accessible at /terms without authentication.
 */
export default function Terms() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container max-w-4xl py-16">
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-muted-foreground mb-8">Last updated: October 16, 2026</p>

        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6">
          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">1. Agreement</h2>
            <p>
              These Terms govern use of the Shopify Scope A version of ReconcileAI. By installing or using the app, you agree
              to these Terms. ReconcileAI is provided by Infinity AI Africa Limited (&quot;Infinity AI&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">2. Scope A service</h2>
            <p>
              Scope A is a read-only order-evidence reconciliation workspace. It can read recent Shopify order evidence using
              the permission you authorize and compare it with settlement evidence that you provide. It is not a payment
              processor, settlement engine, ledger of record, accounting service, or source system of record.
            </p>
            <p className="mt-2">
              Scope A cannot edit Shopify orders, issue refunds, move funds, post to a general ledger, or change Shopify store
              settings. Shopify Payments payouts and fees are not connected in this release. A person remains responsible for
              reviewing reconciliation outputs and approving any business decision.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">3. Access, installation, and your responsibilities</h2>
            <p>
              You must be authorized to install the app and to provide any settlement evidence you import. You are responsible
              for validating source records, the mapping you confirm, and any decision made from the resulting evidence. Do not
              upload personal customer information or data that you are not authorized to process.
            </p>
            <p className="mt-2">
              ReconcileAI&apos;s Shopify access is limited to <code>read_orders</code> for Scope A. You may revoke that access by
              uninstalling the app from Shopify. We may suspend access where necessary to protect the service, comply with law,
              or investigate a security issue.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">4. Launch pricing</h2>
            <p>
              Scope A is offered without charge at launch. ReconcileAI does not use Shopify billing for this release. If a paid
              offering is introduced later, its price, billing terms, and effective date will be presented before any charge is
              made; your continued use alone will not create a charge.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">5. Data and privacy</h2>
            <p>
              Your use of the service is also governed by our <a href="/privacy" className="text-primary underline">Privacy Notice</a>.
              We process data only for the Scope A reconciliation and service-protection purposes described there. You retain
              responsibility for the data you provide and for any applicable retention, financial-control, and regulatory duties.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">6. No professional or financial advice</h2>
            <p>
              ReconcileAI presents evidence and workflow support. It does not provide legal, tax, audit, accounting, investment,
              or financial advice, and it does not certify the accuracy, completeness, or compliance of a reconciliation. You
              must apply your own review and approval controls before acting on any result.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">7. Service availability and changes</h2>
            <p>
              We may maintain, change, suspend, or discontinue the launch service where reasonably necessary. We do not promise
              uninterrupted availability, a particular outcome, or a particular reconciliation rate. We will use reasonable
              efforts to communicate material changes affecting the Scope A service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">8. Intellectual property</h2>
            <p>
              ReconcileAI, its software, interface, and documentation are owned by Infinity AI or its licensors. Subject to these
              Terms, we grant you a limited, non-exclusive, non-transferable right to use Scope A for your internal business
              reconciliation purpose. You retain your rights in your data.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">9. Limitation of liability</h2>
            <p>
              To the extent permitted by applicable law, Infinity AI is not liable for indirect, incidental, special,
              consequential, or punitive loss arising from use of the launch service. Nothing in these Terms excludes liability
              that cannot lawfully be excluded.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">10. Termination</h2>
            <p>
              You may stop using Scope A and uninstall the app at any time. When the app is uninstalled, ReconcileAI marks the
              store as uninstalled and deletes its Shopify access credentials, so it can no longer read your store. When Shopify
              then sends a <code>shop/redact</code> request, ReconcileAI also fences the workspace and blocks further processing,
              as described in the Privacy Notice.
            </p>
            <p className="mt-2">
              Shopify&apos;s customer-level privacy requests (<code>customers/data_request</code> and{" "}
              <code>customers/redact</code>) do not end or restrict your access. Each is handled for the customer it names,
              as described in the Privacy Notice.
            </p>
            <p className="mt-2">
              We may terminate or suspend access if these Terms are breached or if continued access presents a security or
              legal risk.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">11. Governing law and contact</h2>
            <p>
              These Terms are governed by the laws of the Federal Republic of Nigeria, subject to any mandatory law that applies
              to you. Questions about these Terms can be sent to{" "}
              <a href="mailto:support@reconcileaiafrica.com" className="text-primary underline">support@reconcileaiafrica.com</a>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
