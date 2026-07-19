/**
 * Privacy Policy page — required for SHOPLINE App Store listing.
 * Accessible at /privacy (public, no auth required).
 */
export default function Privacy() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container max-w-4xl py-16">
        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-muted-foreground mb-8">
          Last updated: July 19, 2026
        </p>

        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6">
          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">1. Introduction</h2>
            <p>
              ReconcileAI (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) is operated by Infinity AI Africa Limited
              (&quot;Infinity AI&quot;). This Privacy Policy explains how we collect, use, disclose,
              and safeguard your information when you use our financial reconciliation
              application available through the SHOPLINE App Store.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">2. Information We Collect</h2>
            <p>When you install and use ReconcileAI, we access the following data from your SHOPLINE store:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li><strong>Order data:</strong> Order IDs, amounts, payment status, timestamps, and customer references (no personal customer data is stored)</li>
              <li><strong>Payment transactions:</strong> Transaction IDs, gateway references, amounts, currencies, and settlement status</li>
              <li><strong>Payout/settlement data:</strong> Payout IDs, amounts, fees, and settlement dates</li>
              <li><strong>Store information:</strong> Store name, currency, timezone, and domain</li>
            </ul>
            <p className="mt-4">We also collect:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li><strong>Account information:</strong> Your email address and name (provided during SHOPLINE OAuth authorization)</li>
              <li><strong>Usage data:</strong> Feature usage patterns, reconciliation run history, and error logs</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">3. How We Use Your Information</h2>
            <p>We use the collected information exclusively to:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>Perform automated financial reconciliation between your orders, payments, and settlements</li>
              <li>Detect and classify payment exceptions (shortfalls, duplicates, unmatched transactions)</li>
              <li>Generate reconciliation reports and settlement monitoring dashboards</li>
              <li>Send you alerts about reconciliation exceptions and billing notifications</li>
              <li>Improve our reconciliation algorithms and service reliability</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">4. Data Storage and Security</h2>
            <p>
              Your data is stored in encrypted databases hosted on secure cloud infrastructure.
              All data in transit is encrypted using TLS 1.3. Access tokens are encrypted at rest
              using AES-256 envelope encryption. We implement role-based access controls and
              maintain audit logs for all data access.
            </p>
            <p className="mt-2">
              We retain your reconciliation data for as long as your subscription is active,
              plus 90 days after cancellation to allow for data export. After this period,
              all data is permanently deleted.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">5. Data Sharing</h2>
            <p>
              We do not sell, rent, or share your financial data with third parties.
              We may share data only in the following circumstances:
            </p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>With your explicit consent</li>
              <li>To comply with legal obligations or valid legal processes</li>
              <li>With our infrastructure providers (cloud hosting, database) who are bound by data processing agreements</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">6. Your Rights (GDPR/POPIA Compliance)</h2>
            <p>You have the right to:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li><strong>Access:</strong> Request a copy of all data we hold about your store</li>
              <li><strong>Rectification:</strong> Request correction of inaccurate data</li>
              <li><strong>Erasure:</strong> Request deletion of your data (subject to legal retention requirements)</li>
              <li><strong>Portability:</strong> Export your reconciliation data in machine-readable format</li>
              <li><strong>Restriction:</strong> Request limitation of processing</li>
            </ul>
            <p className="mt-2">
              To exercise these rights, contact us at{" "}
              <a href="mailto:privacy@reconcileaiafrica.com" className="text-primary underline">
                privacy@reconcileaiafrica.com
              </a>
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">7. Data Deletion on Uninstall</h2>
            <p>
              When you uninstall ReconcileAI from your SHOPLINE store, we receive an automatic
              notification. Within 30 days of uninstallation, we will:
            </p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>Revoke all access tokens to your SHOPLINE store</li>
              <li>Delete all stored order, payment, and settlement data</li>
              <li>Remove your account and subscription records</li>
            </ul>
            <p className="mt-2">
              You may also request immediate deletion by contacting our support team.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">8. Cookies and Tracking</h2>
            <p>
              ReconcileAI uses essential session cookies for authentication only.
              We do not use advertising cookies, tracking pixels, or third-party analytics
              that collect personal data.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">9. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify you of any
              material changes by posting the new policy on this page and updating the
              &quot;Last updated&quot; date.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">10. Contact Us</h2>
            <p>
              If you have questions about this Privacy Policy, please contact:
            </p>
            <p className="mt-2">
              <strong>Infinity AI Africa Limited</strong><br />
              Email:{" "}
              <a href="mailto:privacy@reconcileaiafrica.com" className="text-primary underline">
                privacy@reconcileaiafrica.com
              </a><br />
              Website: <a href="https://www.reconcileaiafrica.com" className="text-primary underline">www.reconcileaiafrica.com</a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
