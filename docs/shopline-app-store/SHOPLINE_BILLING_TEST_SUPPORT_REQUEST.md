# Support Request: Controlled App-Subscription Lifecycle Test for ReconcileAI Dev Store

**Subject:** Request for a no-charge test path for public-app subscription lifecycle webhooks

Hello SHOPLINE Partner Support,

We are preparing **ReconcileAI Dev Store**, a Redirected public application, for App
Store review. The integration is installed and connected in our primary development
store, `reconcileai-dev`. We have completed controlled evidence for OAuth, order and
payment-related webhook processing, read-only sync, settlement-file reconciliation,
GDPR signature handling, and App Store listing assets.

Our remaining pre-submission verification is the **app-subscription lifecycle**. The
app has approved plans with a seven-day trial, but the Partner Portal’s **Test App in
development store** route exposes only an OAuth/access test. It does not expose plan
selection, trial activation, cancellation, or an application-subscription test
workflow. Accordingly, the development store has no subscription-state record and no
received subscription-lifecycle webhook to verify.

Could you please confirm the supported Partner/developer test path to perform a
**no-charge, cancellable** lifecycle test for a public app? Specifically, we need to:

1. activate a test trial or test subscription for `reconcileai-dev` without charging
   a merchant;
2. observe the application-subscription creation or activation webhook delivered to
   our configured endpoint;
3. cancel the test subscription before any renewal; and
4. confirm whether paid and expiry webhooks can be simulated in the approved test
   environment, rather than triggering a real charge or waiting for a full billing
   period.

We will retain only redacted delivery metadata and the resulting test subscription
state. We will not use a merchant store, production customer data, or a chargeable
subscription to obtain this evidence.

Thank you for confirming the recommended test route and any prerequisites.

Regards,  
Richard Anwanakak  
Infinity AI Africa Limited  
`richard@infinityaiafrica.ai`
