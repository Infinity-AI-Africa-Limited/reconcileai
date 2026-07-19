# SHOPLINE Partner Portal — App Settings Page Observations

## What's Visible

### Basic Information Settings
- App name: ReconcileAI
- App URL: https://www.reconcileaiafrica.com/api/shopline/install ✓
- App callback URL: https://www.reconcileaiafrica.com/api/shopline/callback ✓
- App loading mode: Embedded (selected) vs Redirected

### Embed in SHOPLINE POS
- Not embedded currently
- Option to "Enable" embedding in SHOPLINE POS

### App Icons
- App logo (optional): 120x120px, jpg/jpeg/png, max 2MB
- Used for internal management and developer store testing only

### Security Settings
- IP whitelist (optional): up to 100 IPs, semicolon-separated

### App Contact
- Contact name: (empty)
- Contact email: (empty)

### Sales Channel
- Warning: "This action will irreversibly convert your app into a sales channel"
- Button: "Turn the App into sales channel"
- NOT needed for ReconcileAI (we're a financial ops layer, not a sales channel)

### GDPR Required Webhooks
- Deleted endpoint of customer data: (empty, needs filling)
- Deleted endpoint of store data: (empty, needs filling)

### App Proxy
- Subpath prefix: apps (dropdown)
- Subpath: (optional)
- Proxy URL: (optional)

## What's NOT Visible on This Page
- Permissions/Scopes configuration
- Pricing/Plans configuration
- Webhook secret/signing key
- Webhook subscription management

## Navigation (Left Sidebar)
- Home
- Stores
- Referrals
- Apps (currently selected)
- Resources section:
  - Partner docs
  - Product docs

## Actions Needed
1. Fill GDPR endpoints:
   - Customer data: https://www.reconcileaiafrica.com/api/shopline/gdpr/customers-data-request
   - Store data: https://www.reconcileaiafrica.com/api/shopline/gdpr/shop-data-request
2. Fill App Contact info
3. Look for Permissions in a different section (maybe under the app's detail page, not settings)
4. Look for Pricing/Plans in "App Details" section
