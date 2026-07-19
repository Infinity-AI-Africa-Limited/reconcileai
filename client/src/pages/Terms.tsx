/**
 * Terms of Service page — required for SHOPLINE App Store listing.
 * Accessible at /terms (public, no auth required).
 */
export default function Terms() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container max-w-4xl py-16">
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-muted-foreground mb-8">
          Last updated: July 19, 2026
        </p>

        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6">
          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">1. Agreement to Terms</h2>
            <p>
              By installing ReconcileAI from the SHOPLINE App Store, you agree to be bound
              by these Terms of Service (&quot;Terms&quot;). ReconcileAI is provided by Infinity AI
              Africa Limited (&quot;Infinity AI&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;).
            </p>
            <p className="mt-2">
              If you do not agree to these Terms, do not install or use ReconcileAI.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">2. Description of Service</h2>
            <p>
              ReconcileAI is an automated financial reconciliation platform that connects to
              your SHOPLINE store to match orders, payment transactions, and settlement payouts.
              The service identifies discrepancies, classifies exceptions, and provides
              real-time monitoring of your financial operations.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">3. Subscription and Billing</h2>
            <p>
              ReconcileAI offers multiple subscription tiers billed monthly through the
              SHOPLINE App Store billing system. All plans include a 7-day free trial.
            </p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li><strong>Starter:</strong> $29/month — Up to 500 orders/month, 1 store</li>
              <li><strong>Growth:</strong> $79/month — Up to 2,000 orders/month, 3 stores</li>
              <li><strong>Professional:</strong> $149/month — Up to 10,000 orders/month, 10 stores</li>
              <li><strong>Scale:</strong> $299/month — Up to 50,000 orders/month, 50 stores</li>
              <li><strong>Enterprise:</strong> $499/month — Unlimited orders and stores</li>
            </ul>
            <p className="mt-4">
              Billing is managed by SHOPLINE. You authorize SHOPLINE to charge your registered
              payment method on a recurring monthly basis. You may cancel your subscription
              at any time through the SHOPLINE App Store.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">4. Free Trial</h2>
            <p>
              New installations receive a 7-day free trial with full access to the selected
              plan&apos;s features. After the trial period, your subscription will automatically
              convert to a paid subscription unless cancelled before the trial ends.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">5. Acceptable Use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>Use the service for any unlawful purpose or in violation of any applicable laws</li>
              <li>Attempt to reverse-engineer, decompile, or disassemble the service</li>
              <li>Share your account credentials with unauthorized third parties</li>
              <li>Use the service to process data from stores you do not own or have authorization to manage</li>
              <li>Exceed the usage limits of your subscription tier (orders/month, connected stores)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">6. Data Accuracy and Limitations</h2>
            <p>
              ReconcileAI performs automated reconciliation based on the data available through
              the SHOPLINE API. While we strive for accuracy, we do not guarantee that all
              discrepancies will be detected or that all matches will be correct.
            </p>
            <p className="mt-2">
              <strong>ReconcileAI is a decision-support tool, not a replacement for professional
              accounting or auditing services.</strong> You remain responsible for verifying
              reconciliation results and making final financial decisions.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">7. Service Availability</h2>
            <p>
              We target 99.9% uptime for the ReconcileAI service. However, we do not guarantee
              uninterrupted access. Scheduled maintenance windows will be communicated in advance.
              We are not liable for downtime caused by SHOPLINE platform issues, network
              outages, or force majeure events.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">8. Intellectual Property</h2>
            <p>
              ReconcileAI, including its algorithms, user interface, documentation, and
              branding, is the intellectual property of Infinity AI Africa Limited.
              Your subscription grants you a non-exclusive, non-transferable license to
              use the service for your business operations.
            </p>
            <p className="mt-2">
              Your financial data remains your property at all times. We claim no ownership
              over the data processed through our service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">9. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by applicable law, Infinity AI Africa Limited
              shall not be liable for any indirect, incidental, special, consequential, or
              punitive damages, including but not limited to loss of profits, data, or
              business opportunities, arising from your use of ReconcileAI.
            </p>
            <p className="mt-2">
              Our total liability for any claim arising from these Terms shall not exceed
              the amount you paid for the service in the 12 months preceding the claim.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">10. Termination</h2>
            <p>
              You may terminate your subscription at any time by uninstalling ReconcileAI
              from your SHOPLINE store. We may suspend or terminate your access if you
              violate these Terms or if your billing fails after multiple attempts.
            </p>
            <p className="mt-2">
              Upon termination, your access to the service will cease immediately.
              Data retention and deletion follow our Privacy Policy.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">11. Governing Law</h2>
            <p>
              These Terms are governed by the laws of the Federal Republic of Nigeria.
              Any disputes shall be resolved through arbitration in Lagos, Nigeria,
              under the rules of the Lagos Court of Arbitration.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">12. Changes to Terms</h2>
            <p>
              We reserve the right to modify these Terms at any time. Material changes
              will be communicated via email or in-app notification at least 30 days
              before taking effect. Continued use after changes constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-4">13. Contact</h2>
            <p>
              For questions about these Terms, contact:
            </p>
            <p className="mt-2">
              <strong>Infinity AI Africa Limited</strong><br />
              Email:{" "}
              <a href="mailto:legal@reconcileaiafrica.com" className="text-primary underline">
                legal@reconcileaiafrica.com
              </a><br />
              Website: <a href="https://www.reconcileaiafrica.com" className="text-primary underline">www.reconcileaiafrica.com</a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
