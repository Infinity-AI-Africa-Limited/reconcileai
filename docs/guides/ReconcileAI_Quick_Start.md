# ReconcileAI Quick Start Guide

**Version**: 2.0  
**Last Updated**: February 26, 2026  
**Author**: Manus AI

---

## Welcome to ReconcileAI

ReconcileAI is an agentic AI-assisted financial reconciliation platform that reduces false positive rates from 35-65% to less than 2%, eliminates 60% of manual matching time, and increases audit confidence from 6.5/10 to 9+/10. This quick start guide will help you get up and running in minutes.

---

## Step 1: Log In to Your Account

Access the ReconcileAI platform through your organization's login URL. Click the "Log In" button and authenticate using your Manus OAuth credentials. If this is your first login, you'll be prompted to complete your profile information including your full name and role confirmation.

Upon successful login, you'll see the main Dashboard displaying reconciliation overview and analytics. The sidebar navigation on the left provides access to all platform features. Take a moment to explore the interface and familiarize yourself with the layout.

---

## Step 2: Upload Your First Transaction Dataset

Navigate to **Upload Data** in the sidebar to begin uploading transaction data. ReconcileAI supports CSV and Excel file formats with the following required columns:

- **Transaction ID**: Unique identifier for each transaction
- **Date**: Transaction date in YYYY-MM-DD format
- **Amount**: Numeric transaction amount
- **Currency**: Three-letter ISO currency code (e.g., NGN, USD)
- **Reference**: Transaction reference number
- **Description**: Transaction details or description
- **Channel**: Payment channel (e.g., NIBSS, POS, Mobile Money)

You can upload data using drag-and-drop by dragging your file directly onto the upload area, or by clicking "Choose File" to browse and select your file. The platform validates your file and displays a preview showing the first 10 rows, total transaction count, detected currency, and identified payment channel.

Review the preview to ensure data is parsed correctly, then click "Confirm Upload" to process the file. The platform will parse and normalize your transaction data, which typically takes a few seconds for files with thousands of transactions.

---

## Step 3: Create Your First Reconciliation Job

After uploading both source and target transaction datasets, navigate to **Reconciliation** in the sidebar and click "New Reconciliation Job". Configure your reconciliation job with the following parameters:

**Basic Settings:**
- **Job Name**: Enter a descriptive name like "Daily NIBSS Reconciliation - Feb 26"
- **Source Channel**: Select the channel for your source transactions
- **Target Channel**: Select the channel for your target transactions
- **Module Type**: Choose from three options:
  - **Transaction Integrity**: Internal system validation
  - **Settlement**: External settlement validation
  - **Account-Level**: GL and balance validation

**Matching Parameters:**
- **Amount Tolerance**: Default ±0.5% (adjust based on your data characteristics)
- **Date Window**: Default ±3 days (adjust for your settlement cycles)
- **Confidence Threshold**: Default 0.7 (higher = stricter matching)

Click "Create Job" to start the reconciliation process. The platform will execute a three-pass matching algorithm combining exact matching, tolerance-based matching, and fuzzy matching to maximize accuracy.

---

## Step 4: Review Matching Results

Once your reconciliation job completes (typically within 1-3 minutes for standard datasets), click on the job name to view detailed results. The results page displays:

**Summary Statistics:**
- Total source and target transactions
- Matched count and percentage
- Unmatched count
- Exception count by category
- Duplicate count

**Detailed Transaction Table:**
- Each transaction with its match status
- Confidence score for matched transactions
- Matched counterparty details
- Exception reasons for flagged transactions

Matched transactions with high confidence scores (above 0.9) typically require no further action. Transactions with lower confidence scores or flagged exceptions should be reviewed manually through the exception workflow.

---

## Step 5: Manage Exceptions

Navigate to **Exceptions** in the sidebar to access the exception queue. Exceptions are categorized into three types:

- **Missing Counterparty**: Transaction exists in source but not in target (or vice versa)
- **Amount Mismatch**: Matching transactions have different amounts exceeding tolerance
- **Timing Difference**: Matching transactions have dates outside the date window

For each exception, the platform provides an AI-suggested resolution based on confidence scores and transaction patterns. Review the exception details including source and target transaction information, identified discrepancies, and AI suggestion.

Take action on each exception by:
- **Accepting the Match**: If discrepancies are acceptable
- **Rejecting the Match**: If transactions are unrelated
- **Marking as False Positive**: If the exception is a system error
- **Escalating**: If additional expertise is required

All exception resolutions are logged in the audit trail for compliance and quality assurance.

---

## Step 6: Generate Your First Report

Navigate to **Reports** in the sidebar to access reporting features. You can generate reports in two ways:

**Manual Report Generation:**
1. Navigate to a completed reconciliation job
2. Click "Send Report Now"
3. Enter recipient email addresses
4. Select report format (HTML email or PDF attachment)
5. Click "Send Report"

**Automated Report Scheduling:**
1. Navigate to **Email Settings** in the sidebar
2. Click "Configure Email Reports"
3. Enter recipient email addresses
4. Select report frequency (daily, weekly, or monthly)
5. Choose report format and content filters
6. Click "Save Settings"

Reports include match summary, exception breakdown by category, channel performance metrics, trend data, and detailed transaction listings for exceptions and unmatched items.

---

## Next Steps

Now that you've completed your first reconciliation workflow, explore these advanced features to maximize platform value:

**Automate Recurring Reconciliation:**
Navigate to **Schedules** to set up automated reconciliation jobs that run daily, weekly, or at custom intervals. This eliminates manual job creation for routine reconciliation processes.

**Monitor Real-Time Progress:**
Navigate to **Monitor** to track active reconciliation jobs in real-time with progress bars, elapsed time, and estimated completion time. This visibility helps during high-volume reconciliation periods.

**Configure API Integration:**
Navigate to **Integrations** to set up REST API access or SFTP connections for automated transaction data ingestion. This eliminates manual file uploads for organizations with automated data feeds.

**Explore Role-Based Dashboards:**
If you're a CFO, operations lead, or auditor, explore the specialized dashboard views tailored to your role through the Dashboard dropdown menu. These views provide metrics and workflows specific to your responsibilities.

**Review Audit Trail:**
Navigate to **Audit Trail** to view comprehensive logging of all system activities. This is essential for compliance, security monitoring, and troubleshooting purposes.

---

## Getting Help

**In-Platform Help:**
Click the question mark icon in the top right corner to access context-sensitive help articles and video tutorials.

**Documentation:**
Navigate to **Documentation** in the sidebar to access the complete User Guide, Administrator Guide, and API documentation.

**Support:**
For technical assistance, email support@reconcileai.com or click "Contact Support" in the help menu. Priority support is available for urgent issues affecting production workflows.

**Training:**
Live webinar sessions covering platform fundamentals and advanced features are available. Check the training portal for upcoming sessions and recorded content.

---

## Tips for Success

**Start Small:**
Begin with a single channel or small dataset to familiarize yourself with the platform before scaling to full production volumes.

**Calibrate Matching Parameters:**
Monitor your first few reconciliation jobs and adjust amount tolerance and date window based on observed exception patterns. Different channels may require different parameters.

**Review AI Suggestions:**
The AI-powered matching engine improves over time based on your manual review feedback. Consistently reviewing and acting on AI suggestions trains the model for your specific data patterns.

**Leverage Automation:**
Once you're comfortable with manual reconciliation workflows, implement scheduled tasks and API integrations to automate routine processes and free up time for exception management.

**Monitor Performance:**
Regularly review match rates, exception volumes, and processing times to identify trends and optimization opportunities. The platform provides comprehensive analytics to support continuous improvement.

---

## Common First-Time Questions

**Q: What file format should I use for uploads?**
CSV is recommended for simplicity and compatibility. Excel (XLS/XLSX) is also supported if your data is already in that format.

**Q: How do I know which module type to choose?**
- **Transaction Integrity** for internal system validation across multiple internal platforms
- **Settlement** for validating bulk settlements against detailed transaction reports
- **Account-Level** for GL reconciliation and regulatory compliance

**Q: What if my match rate is lower than expected?**
Review a sample of unmatched transactions to identify patterns. Common issues include systematic date differences, amount format inconsistencies, or missing reference numbers. Adjust matching parameters accordingly.

**Q: Can I undo an exception resolution?**
Yes, exception resolutions can be reversed through the audit trail. Navigate to the exception, view its history, and click "Reverse Resolution" to return it to the queue.

**Q: How long is my data retained?**
The default retention period is 7 years for compliance purposes. Administrators can adjust retention policies through system settings.

---

**Welcome to ReconcileAI! We're excited to help you transform your reconciliation workflows.**

For comprehensive documentation, visit the **Documentation** page in the sidebar or email docs@reconcileai.com with feedback and questions.

**Document Version**: 2.0  
**Last Updated**: February 26, 2026
