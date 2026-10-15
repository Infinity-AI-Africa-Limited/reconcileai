/**
 * Public privacy notice for ReconcileAI's Shopify Scope A app.
 * Accessible at /privacy without authentication.
 */
export default function Privacy() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container max-w-4xl py-16">
        <h1 className="text-3xl font-bold mb-2">Privacy Notice</h1>
        <p className="text-muted-foreground mb-8">Last updated: October 15, 2026</p>

        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6">
          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">1. Who we are</h2>
            <p>
              ReconcileAI is operated by Infinity AI Africa Limited (&quot;Infinity AI&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;).
              This notice describes the Shopify Scope A version of ReconcileAI: a read-only order-evidence and
              merchant-provided settlement-evidence reconciliation workspace.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">2. Shopify data we access and keep</h2>
            <p>
              With your authorization, ReconcileAI requests Shopify&apos;s <code>read_orders</code> permission. We use the
              minimum order evidence needed to compare Shopify orders and refunds with settlement evidence that you provide.
            </p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li><strong>Store metadata:</strong> store domain, display name, currency, and timezone.</li>
              <li><strong>Order and refund evidence:</strong> identifiers and references, amounts and currency, order and refund dates, financial status, cancellation status, and update timestamps.</li>
              <li><strong>Merchant-provided settlement evidence:</strong> the reference, amount, currency, settlement date, fee, and limited provenance fields that you confirm for the reconciliation purpose.</li>
              <li><strong>Access and operational evidence:</strong> the merchant administrator identity needed to authorize the workspace, sync and reconciliation status, and security/audit events.</li>
            </ul>
            <p className="mt-4">
              ReconcileAI does <strong>not</strong> request Shopify Payments payouts or fee access in Scope A. It does not
              request write permissions, edit Shopify records, issue refunds, or move money. We do not intentionally retain
              customer names, email addresses, phone numbers, delivery addresses, payment-instrument details, or raw Shopify
              webhook payloads. Merchants should avoid uploading customer personal data in settlement files; the Scope A
              importer is designed to minimize the fields it keeps.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">3. How we use the data</h2>
            <p>We use this data only to provide and protect the requested reconciliation workspace, including to:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>Synchronize the recent Shopify order evidence that you request;</li>
              <li>Compare that evidence with settlement evidence you control and import;</li>
              <li>Present matches, differences, investigation context, and audit evidence to authorized users;</li>
              <li>Prevent duplicate imports, maintain service security, and investigate operational errors; and</li>
              <li>Respond to Shopify&apos;s mandatory privacy webhooks and to valid data-rights requests.</li>
            </ul>
            <p className="mt-4">
              ReconcileAI is a read-only financial-operations control layer. It does not make payments, post to a ledger,
              change Shopify data, or make an autonomous financial decision.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">4. Sharing and processing locations</h2>
            <p>
              We do not sell Shopify or merchant data. We share it only with service providers that operate the hosting,
              database, secure storage, and communications infrastructure needed to provide ReconcileAI, or where disclosure
              is required by applicable law. Those providers process data only on our instructions for the stated purpose.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">5. Security</h2>
            <p>
              We use technical and organizational safeguards appropriate to the Scope A service, including encrypted transport,
              access controls, tenant separation, protected token storage, and audit evidence. No system can be guaranteed
              perfectly secure; please contact us promptly if you believe an account or data has been exposed.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">6. Retention and deletion</h2>
            <p>
              We retain Scope A data only for as long as it is needed to operate the reconciliation workspace, meet an
              applicable legal obligation, resolve a security or operational issue, or complete a valid deletion request.
              We do not retain raw Shopify webhook payloads, and the settlement evidence file is parsed in memory rather
              than stored as the original uploaded file.
            </p>
            <p className="mt-2">
              If Shopify sends a <code>shop/redact</code> request, ReconcileAI immediately fences the affected workspace,
              revokes its Shopify credentials, blocks further processing, and records the deletion work for controlled
              completion. We treat a deletion request as complete only when the relevant deletion steps and evidence have
              completed; a fence or a request receipt is not represented as completion.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">7. Your choices and requests</h2>
            <p>
              You may ask about access, correction, restriction, or deletion of data associated with your ReconcileAI Shopify
              workspace. Shopify may also send us the mandatory data-request and redaction webhooks described in its platform
              requirements. To make a request, contact us with your store domain and the nature of the request at{" "}
              <a href="mailto:support@reconcileaiafrica.com" className="text-primary underline">
                support@reconcileaiafrica.com
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">8. Changes to this notice</h2>
            <p>
              We may update this notice when the Scope A service or applicable requirements change. The current version and
              its effective date will be posted on this page.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">9. Contact</h2>
            <p>
              <strong>Infinity AI Africa Limited</strong><br />
              Email: <a href="mailto:support@reconcileaiafrica.com" className="text-primary underline">support@reconcileaiafrica.com</a><br />
              Website: <a href="https://www.reconcileaiafrica.com" className="text-primary underline">www.reconcileaiafrica.com</a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
