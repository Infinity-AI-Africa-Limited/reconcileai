# ReconcileAI User Guide

**Version**: 2.0  
**Last Updated**: February 26, 2026  
**Author**: Manus AI

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Getting Started](#2-getting-started)
3. [User Roles and Permissions](#3-user-roles-and-permissions)
4. [Core Reconciliation Workflows](#4-core-reconciliation-workflows)
5. [Three-Module Architecture](#5-three-module-architecture)
6. [Advanced Features](#6-advanced-features)
7. [Administration and Configuration](#7-administration-and-configuration)
8. [API and Integrations](#8-api-and-integrations)
9. [Troubleshooting and FAQ](#9-troubleshooting-and-faq)

---

## 1. Introduction

### 1.1 What is ReconcileAI?

ReconcileAI is an agentic AI-assisted financial reconciliation platform purpose-built for African banking and FinTech institutions. The platform addresses the critical operational challenge of manual, error-prone reconciliation processes by deploying autonomous AI agents that can reason, plan, and execute reconciliation tasks independently within defined boundaries, while keeping humans in control of final decisions.

The platform reduces false positive rates from 35-65% to less than 2%, eliminates 60% of manual matching time, and increases audit confidence from 6.5/10 to 9+/10 for Central Bank of Nigeria (CBN) compliance. ReconcileAI is architected around three core modular reconciliation types that can be enabled or disabled based on client needs.

### 1.2 Key Features

ReconcileAI provides comprehensive reconciliation capabilities across the entire transaction lifecycle. The platform supports multi-channel transaction ingestion from Nigerian payment systems including NIBSS, POS processors, mobile money platforms, bank statements, FinTech APIs, USSD, and NEFT. The AI-powered matching engine employs a three-pass matching algorithm combining exact matching, tolerance-based matching with configurable thresholds, and fuzzy matching for ambiguous cases.

The exception management system categorizes discrepancies into missing counterparty, amount mismatch, and timing difference categories, with AI-suggested resolutions for each exception type. Real-time dashboards provide match rate metrics, exception summaries, and channel performance analytics. The platform maintains comprehensive audit trails logging all matching decisions, manual interventions, and system actions in CBN-compliant reporting formats.

Advanced features include automated email reconciliation reports with configurable frequency and recipients, scheduled reconciliation tasks with cron-based scheduling, real-time job monitoring with progress tracking, SFTP and REST API auto-ingestion for automated data feeds, AI-powered anomaly detection using statistical and pattern-based methods, and role-based dashboard views tailored for CFOs, operations teams, and auditors.

### 1.3 System Requirements

ReconcileAI is a web-based platform accessible through modern web browsers including Chrome 90+, Firefox 88+, Safari 14+, and Edge 90+. The platform requires a stable internet connection with minimum 1 Mbps bandwidth recommended. For optimal performance, users should have at least 4GB RAM and a screen resolution of 1280x720 or higher.

File uploads support CSV and Excel formats with a maximum file size of 10MB per upload and batch size limits of 5,000 transactions per upload. The platform supports 15 African currencies plus major international currencies including NGN, USD, EUR, GBP, ZAR, KES, GHS, EGP, TZS, UGX, XOF, XAF, MWK, ZMW, and RWF.

---

## 2. Getting Started

### 2.1 Account Access

ReconcileAI uses Manus OAuth for secure authentication. Users access the platform through the login portal at the application URL. New users receive invitation emails from their organization administrators containing a unique login link. Upon first login, users are prompted to complete their profile information including full name, role, and organization details.

The platform supports three access levels: Administrator with full system access including user management and system configuration, Standard User with access to reconciliation workflows and reporting, and Guest User with read-only access to demonstration data. Session timeouts occur after 30 minutes of inactivity for security purposes.

### 2.2 Dashboard Overview

Upon successful login, users are directed to the main dashboard displaying reconciliation overview and analytics. The dashboard presents four key metric cards showing total transactions across all channels, match rate percentage with matched transaction count, open exceptions requiring review, and unmatched transactions requiring attention.

The reconciliation jobs section displays total jobs count, completed jobs, currently running jobs, and average match rate across all jobs. The exceptions summary breaks down total exceptions into open, in review, and resolved categories. Channel performance metrics show reconciliation status by payment channel including NIBSS, POS, Mobile Money, and Bank Statements.

The sidebar navigation provides access to all platform features organized into logical sections: Dashboard for overview and analytics, Upload Data for transaction ingestion, Reconciliation for job management, Multi-Channel for channel-specific views, Exceptions for discrepancy management, Transactions for search and filtering, Review Queue for manual intervention, Audit Trail for compliance logging, Reports for automated reporting, Schedules for task automation, Monitor for real-time tracking, Email Settings for report configuration, Sample Data for testing, Integrations for API and webhook management, and Admin sections for user management and module configuration.

### 2.3 Navigation and Interface

The platform employs a consistent navigation pattern with a persistent sidebar on the left containing primary navigation links, a top header displaying the current page title and user profile menu, and a main content area for page-specific content and actions. The user profile menu in the top right provides access to account settings, role information, and logout functionality.

Key interface patterns include action buttons positioned in the top right of content sections for primary actions, data tables with sortable columns, pagination, and filtering capabilities, modal dialogs for forms and confirmations, toast notifications for success and error messages, and loading states with progress indicators for long-running operations.

---

## 3. User Roles and Permissions

### 3.1 Administrator Role

Administrators have full system access and are responsible for platform configuration and user management. Administrator capabilities include creating, editing, and deactivating user accounts, assigning roles and permissions to users, configuring system-wide settings including matching engine parameters, managing module configurations to enable or disable reconciliation modules per organization, viewing all reconciliation jobs across all users, accessing all audit trail entries, managing API keys and webhooks for integrations, and configuring scheduled tasks and email reports.

Administrators access user management through the Admin menu in the sidebar navigation. The user management interface displays a list of all users with their roles, status, and last login information. Administrators can invite new users by clicking "Add User" and entering the user's email address and assigned role. User accounts can be deactivated without deletion to preserve audit trail integrity.

Module configuration is accessed through Admin > Module Configuration. Administrators can enable or disable three reconciliation modules: Transaction Integrity Reconciliation for internal system validation, Settlement Reconciliation for external settlement validation, and Account-Level Reconciliation for GL and account balance validation. Each module can be toggled independently based on organizational needs.

### 3.2 Standard User Role

Standard users have access to core reconciliation workflows and reporting features. User capabilities include uploading transaction data files for reconciliation, creating and managing reconciliation jobs, reviewing and resolving exceptions, searching and filtering transactions, viewing reconciliation reports and analytics, configuring personal email report preferences, and accessing audit trail entries for their own actions.

Users can view only their own reconciliation jobs and associated data. Cross-user data access is restricted to maintain data isolation and security. Users cannot access system configuration, user management, or organization-wide settings. Standard users are the primary operators of the reconciliation platform, executing daily reconciliation tasks and managing exception workflows.

### 3.3 Guest User Role

Guest users have read-only access to demonstration data for platform evaluation purposes. Guest capabilities are limited to viewing pre-populated sample reconciliation jobs, exploring the dashboard and analytics views, reviewing sample exceptions and resolutions, and accessing platform documentation and help resources.

Guest users cannot upload data, create reconciliation jobs, modify any system data, or access real organizational data. Guest sessions are temporary and expire after a defined period. Guest access is designed for platform demonstrations, training sessions, and prospect evaluations before full account provisioning.

### 3.4 Role-Based Dashboard Views

ReconcileAI provides specialized dashboard views tailored to different organizational roles. The CFO Dashboard presents executive-level metrics including aggregate KPIs across all reconciliation activities, 30-day trend analysis for match rates and exception volumes, channel health indicators showing performance by payment channel, and cost analysis metrics demonstrating reconciliation efficiency and ROI.

The Operations Dashboard focuses on actionable workflow management with an exception queue displaying high-priority discrepancies requiring immediate attention, SLA metrics tracking resolution times and backlog size, team performance indicators showing reviewer throughput and accuracy, and pending review counts organized by exception category and age.

The Auditor Dashboard emphasizes compliance and regulatory reporting with compliance metrics indicating adherence to CBN requirements, comprehensive audit trail viewer with advanced filtering by user, action type, and date range, regulatory export functionality for generating compliance reports, and data integrity indicators showing reconciliation completeness and accuracy.

---

## 4. Core Reconciliation Workflows

### 4.1 Transaction Data Upload

The reconciliation process begins with transaction data upload. Users navigate to Upload Data in the sidebar to access the upload interface. The platform supports CSV and Excel file formats with specific column requirements. Required columns include Transaction ID as a unique identifier, Date in YYYY-MM-DD format, Amount as a numeric value, Currency as a three-letter ISO code, Reference as a transaction reference number, Description as transaction details, and Channel indicating the payment channel.

Users can upload data through drag-and-drop functionality by dragging files directly onto the upload area, or through the file picker by clicking "Choose File" to browse and select files. The platform validates file format, size, and structure before processing. Validation checks include file size limits of 10MB maximum, batch size limits of 5,000 transactions per file, required column presence verification, data type validation for numeric and date fields, and currency code validation against supported currencies.

Upon successful validation, the platform displays an upload preview showing the first 10 rows of data, total transaction count, detected currency, identified payment channel, and any validation warnings. Users can review the preview and confirm the upload or cancel to make corrections. After confirmation, the platform processes the file asynchronously, parsing and normalizing transaction data, assigning transactions to the appropriate channel, calculating file hash for duplicate detection, and storing transactions in the database with upload metadata.

Upload history is maintained in the Upload Data page showing all previous uploads with timestamp, file name, transaction count, status (processing, completed, failed), and actions to view details or download the original file. Users can track upload progress through status indicators and receive notifications upon completion or failure.

### 4.2 Creating Reconciliation Jobs

After uploading transaction data, users create reconciliation jobs to match transactions between source and target datasets. Users navigate to Reconciliation in the sidebar and click "New Reconciliation Job" to access the job creation form. The form requires several configuration parameters including job name for identification purposes, source channel selection from uploaded data, target channel selection for comparison, module type selection among Transaction Integrity, Settlement, or Account-Level reconciliation, and matching engine configuration.

Matching engine parameters include amount tolerance specified as a percentage (default ±0.5%), date window in days for timing differences (default ±3 days), and confidence threshold for fuzzy matching (default 0.7 on a 0-1 scale). Advanced options allow users to enable duplicate detection, enable reversal detection, specify currency conversion if cross-currency matching is required, and set lookback days for historical transaction matching.

Upon submitting the job creation form, the platform initiates the reconciliation process asynchronously. The job progresses through several stages: Queued when the job is created and awaiting execution, Running when the matching engine is actively processing transactions, Completed when all matching passes are finished, and Failed if an error occurs during processing. Users can monitor job progress in real-time through the Monitor page or view completed jobs in the Reconciliation page.

### 4.3 Understanding Matching Results

The matching engine employs a three-pass algorithm to maximize match accuracy while minimizing false positives. Pass 1 performs exact matching on transaction ID, reference number, amount, and date, identifying perfect matches with 100% confidence. Pass 2 applies tolerance-based matching using the configured amount tolerance and date window, matching transactions within acceptable variance thresholds. Pass 3 executes fuzzy matching on description and reference fields for ambiguous cases, assigning confidence scores based on text similarity.

Matching results are categorized into four outcome types. Matched transactions have a confirmed counterparty in the target dataset with confidence scores above the threshold. Unmatched transactions have no suitable counterparty found in any matching pass. Exceptions are potential matches flagged for manual review due to discrepancies or low confidence scores. Duplicates are transactions appearing multiple times in the source or target dataset, flagged for investigation.

Users can view detailed matching results by clicking on a completed reconciliation job. The results page displays summary statistics including total source transactions, total target transactions, matched count and percentage, unmatched count, exception count by category, and duplicate count. A detailed transaction table shows each transaction with its match status, confidence score, matched counterparty if applicable, and any exception reasons.

### 4.4 Exception Management Workflow

Exceptions represent discrepancies requiring manual review and resolution. The platform categorizes exceptions into three primary types. Missing Counterparty exceptions occur when a transaction exists in the source but has no match in the target dataset, or vice versa. Amount Mismatch exceptions arise when matching transactions have different amounts exceeding the tolerance threshold. Timing Difference exceptions occur when matching transactions have dates outside the configured date window.

Users access the exception queue through the Exceptions page in the sidebar. The queue displays all open exceptions with priority indicators, exception category, transaction details, AI-suggested resolution, and action buttons. The AI suggestion engine analyzes each exception and recommends resolutions such as accepting the match if the confidence score is close to the threshold, rejecting the match if discrepancies are significant, requesting additional information if data is incomplete, or escalating to a supervisor if the exception requires senior review.

The exception resolution workflow involves several steps. First, the user reviews the exception details including source and target transaction information, identified discrepancies, confidence score, and AI suggestion. Next, the user investigates the root cause by checking transaction descriptions, verifying amounts and dates, consulting external systems if necessary, and reviewing related transactions for context. The user then takes action by accepting the match if discrepancies are acceptable, rejecting the match if transactions are unrelated, marking as false positive if the exception is a system error, or escalating if additional expertise is required.

All exception resolutions are logged in the audit trail with the user ID, timestamp, action taken, resolution reason, and any notes added by the reviewer. This comprehensive logging ensures full traceability for compliance and quality assurance purposes.

### 4.5 Manual Review Queue

The Review Queue provides a dedicated interface for processing exceptions requiring human intervention. Users access the queue through the Review Queue page in the sidebar. The queue displays exceptions sorted by priority, with high-priority exceptions appearing first based on factors such as transaction amount, age of the exception, channel criticality, and previous escalation history.

Each queue item displays essential information including transaction reference, amount and currency, date, channel, exception category, AI suggestion, and time in queue. Users can filter the queue by exception category, channel, date range, and priority level. Bulk actions allow users to process multiple similar exceptions simultaneously, improving efficiency for recurring exception patterns.

The manual review interface presents side-by-side comparison of source and target transactions, highlighting differences in amount, date, reference, and description fields. Users can access additional context including transaction history, related transactions, channel-specific metadata, and external system links if configured. Action buttons enable quick resolution with options to accept match, reject match, mark as false positive, escalate to supervisor, and add notes for audit trail.

---

## 5. Three-Module Architecture

### 5.1 Module Overview

ReconcileAI is architected around three core modular reconciliation types identified through discovery interviews with Nigerian financial institutions. Each module addresses a distinct reconciliation use case and can be deployed independently or combined based on client needs. Organizations can enable or disable modules through the Module Configuration page accessible to administrators.

The modular architecture provides flexibility for organizations to start with the most critical reconciliation type and expand coverage over time. Module-specific configuration allows tailoring of matching parameters, exception categories, and reporting formats to each reconciliation context. This approach reduces implementation complexity and accelerates time-to-value compared to monolithic reconciliation platforms.

### 5.2 Transaction Integrity Reconciliation

Transaction Integrity Reconciliation ensures all transactions are accounted for within internal systems, validating that what goes into the system comes out properly. This module addresses the core question of internal system validation, confirming that transactions are not lost, duplicated, or corrupted as they flow through multiple internal systems.

The module scope is limited to internal system validation only, reconciling transactions across core banking systems, payment gateways, mobile money platforms, POS systems, and other internal data sources. The module does not validate against external parties such as banks, processors, or merchants. Key capabilities include multi-source transaction ingestion from 5-6 internal systems with inconsistent transaction IDs, intelligent matching across systems using reference numbers and descriptions, duplicate detection for both unidirectional and bidirectional duplicates, timestamp normalization handling 23:59:54 to next-day misalignments, amount denomination correction for format mismatches like ₦1,000 versus ₦10, transaction status reconciliation across successful, pending, and failed states, and false positive classification for timing differences, rounding errors, and system lag.

Target users for this module include reconciliation teams managing daily transaction validation, operations leads ensuring data integrity across systems, and compliance officers monitoring transaction accounting accuracy. Success metrics for Transaction Integrity Reconciliation include reducing false positive rates from 35-65% to less than 2%, reducing manual matching time by 60%, achieving 99.9%+ transaction accounting accuracy, and eliminating 30+ minutes wasted per false alarm investigation.

Common use cases include daily end-of-day reconciliation across internal systems, post-migration validation after system upgrades, data quality monitoring for new channel launches, and fraud detection through duplicate and reversal identification. The module is particularly valuable for payment processors managing 20+ reconciliation processes across POS, transfers, bill payments, and web purchases.

### 5.3 Settlement Reconciliation

Settlement Reconciliation validates that bulk settlement amounts match detailed transaction reports, answering the core question of whether the lump sum received equals what reports indicate should be received. This module addresses external party settlement validation between banks and NIBSS, processors and banks, or merchants and processors.

The module scope covers external settlement validation with multi-processor reconciliation across Interswitch, UPSL, eTranzact, Flutterwave, and Paystack. Key capabilities include unified portal orchestration eliminating 3-4 portal logins per processor, settlement window scheduling for 3-4 times per day automation, pre-settlement reconciliation to catch discrepancies before merchant payments, lump sum versus detailed report validation, two-level reconciliation for processor-only FinTechs validating both bank-to-processor and processor-to-merchant settlements, merchant-level grouping to settle merchants with no exceptions immediately, and settlement file format normalization handling different templates across processors.

Target users include settlement officers responsible for daily settlement across multiple processors, finance managers overseeing settlement accuracy and timeliness, and FinTech operations teams managing merchant payment workflows. Success metrics for Settlement Reconciliation include reducing settlement officer workload by 60% from 8 hours to 3 hours daily, enabling pre-settlement reconciliation to prevent merchant under-settlement, eliminating 5+ daily portal logins with a unified view, and processing 3-4 settlement windows per day automatically.

Common use cases include daily settlement reconciliation across multiple payment processors, pre-settlement validation before merchant payouts, settlement window automation for T+0 and T+1 cycles, and merchant under-settlement prevention addressing issues like ₦500M settled instead of ₦600M. The module is critical for banks managing settlement across 3-4 portals on Interswitch alone plus additional processors, and for payment processors preventing 1-2 day delays for settlement corrections.

### 5.4 Account-Level Reconciliation

Account-Level Reconciliation matches bank account balances to transaction reports, ensuring that the sum of all transactions equals the account balance. This module addresses GL and account balance validation, providing the audit trail and confidence required for regulatory compliance and financial reporting.

The module scope covers GL integration and balance validation with comprehensive audit trail generation. Key capabilities include GL integration for automated account balance retrieval, balance validation comparing calculated balances to actual account balances, transaction-to-balance reconciliation ensuring all transactions are reflected in balances, audit trail generation for CBN compliance with full traceability, month-end close acceleration reducing 5-7 day processes to 1-2 days, and regulatory reporting in CBN-compliant formats.

Target users include CFOs and finance directors responsible for financial reporting accuracy, compliance officers managing regulatory requirements, auditors conducting internal and external audits, and accountants performing month-end close procedures. Success metrics for Account-Level Reconciliation include increasing audit confidence from 6.5/10 to 9+/10 for CBN compliance, reducing month-end close from 5-7 days to 1-2 days, achieving 100% audit trail completeness, and eliminating license revocation risk due to reconciliation failures.

Common use cases include month-end and quarter-end close procedures, regulatory audit preparation for surprise CBN inspections, financial statement validation before external reporting, and GL account reconciliation for balance sheet accuracy. The module is essential for FinTechs reporting 6.5-7/10 confidence for surprise CBN audits where unresolved exceptions can cost operating licenses.

### 5.5 Module Configuration

Administrators configure modules through the Module Configuration page accessible from the Admin menu. The configuration interface displays all three modules with toggle switches to enable or disable each module for the organization. Module-specific settings allow customization of matching parameters, exception categories, and reporting formats tailored to each reconciliation type.

For Transaction Integrity Reconciliation, configuration options include false positive detection rules specifying timing thresholds and rounding tolerances, duplicate detection sensitivity for unidirectional and bidirectional duplicates, reversal detection keywords and reference patterns, and status reconciliation mappings between different system statuses. For Settlement Reconciliation, options include settlement window schedules defining T+0, T+1, and custom cycles, processor-specific file format templates, merchant grouping rules for immediate settlement, and pre-settlement validation thresholds.

For Account-Level Reconciliation, configuration includes GL integration endpoints and authentication, balance validation frequency for daily or monthly reconciliation, audit trail retention periods for compliance requirements, and regulatory report templates for CBN and other authorities. Module configurations are versioned and logged in the audit trail, ensuring that changes to reconciliation logic are fully traceable for compliance purposes.

---

## 6. Advanced Features

### 6.1 Automated Email Reports

ReconcileAI provides automated email reconciliation reports with configurable frequency and recipients. Users access email settings through the Email Settings page in the sidebar. The configuration interface allows users to specify report recipients by entering email addresses, select report frequency from daily, weekly, or monthly options, choose report format between HTML email body or PDF attachment, and configure report content filters by channel, date range, or exception category.

Report content includes a match summary showing total transactions, matched count and percentage, and unmatched count, an exception breakdown by category with counts and percentages, channel performance metrics displaying match rates by payment channel, trend data comparing current period to previous periods, and detailed transaction listings for exceptions and unmatched items. Reports are generated automatically based on the configured schedule and sent via the platform notification API.

Users can also trigger manual report generation by navigating to a completed reconciliation job and clicking "Send Report Now". This functionality is useful for ad-hoc reporting requirements or immediate notification of critical reconciliation results. All report generation activities are logged in the audit trail for compliance tracking.

### 6.2 Scheduled Reconciliation Tasks

The Scheduled Reconciliation Task Manager enables automation of recurring reconciliation jobs, eliminating manual job creation for routine reconciliation processes. Users access the schedule manager through the Schedules page in the sidebar. The interface displays all configured schedules with status indicators, next run time, last run result, and action buttons.

Creating a new schedule involves clicking "New Schedule" and configuring several parameters including schedule name for identification, source channel selection, target channel selection, module type selection, matching engine configuration with amount tolerance and date window, schedule frequency using cron expression or preset options like daily, weekly, or monthly, timezone for schedule execution, and email notification settings for success or failure alerts.

The platform provides a visual cron builder for users unfamiliar with cron syntax, allowing schedule configuration through dropdown menus for minute, hour, day of month, month, and day of week. Advanced users can enter cron expressions directly for complex schedules like "0 0 9,13,17 * * 1-5" for weekdays at 9am, 1pm, and 5pm.

Schedule execution is managed by a background service that checks for due schedules every minute. When a schedule is due, the service automatically creates a reconciliation job with the configured parameters, executes the matching engine, processes results, and sends email notifications if configured. Schedule run history is maintained showing execution timestamp, status, match rate, exception count, and processing time. Users can view detailed results for each run by clicking on the history entry.

Schedules can be toggled active or inactive without deletion, preserving configuration and history. This functionality is useful for temporarily pausing schedules during system maintenance or data migration periods. All schedule configuration changes and execution events are logged in the audit trail.

### 6.3 Real-Time Job Monitoring

The Real-Time Job Monitoring Dashboard provides live visibility into reconciliation job execution, enabling users to track progress and identify performance issues. Users access the monitor through the Monitor page in the sidebar. The interface displays active jobs with real-time progress bars, key metrics panels, recent job activity feed, and auto-refresh controls.

Each active job card shows job name, source and target channels, current stage (Pass 1, Pass 2, Pass 3), progress percentage, elapsed time, and estimated time remaining. The progress bar updates in real-time as the matching engine processes transactions, providing visual feedback on job execution status. Users can click on a job card to view detailed progress information including transactions processed, matches found, exceptions identified, and current matching pass details.

Key metrics panels display aggregate statistics across all jobs including active jobs count, average processing time, success rate percentage, and throughput in transactions per minute. These metrics help operations teams understand system performance and capacity utilization. The recent job activity feed shows the last 20 job events with timestamps, including job started, pass completed, job completed, and job failed events.

Auto-refresh controls allow users to configure polling interval from 5 seconds to 60 seconds, or disable auto-refresh for manual control. The default polling interval is 10 seconds, balancing real-time visibility with server load. The monitoring dashboard is particularly valuable during high-volume reconciliation periods or when troubleshooting performance issues.

### 6.4 SFTP and REST API Auto-Ingestion

ReconcileAI supports automated transaction data ingestion through SFTP and REST API integrations, eliminating manual file uploads for organizations with automated data feeds. Users access integration configuration through the Integrations page in the sidebar, which provides separate tabs for API Ingestion and SFTP Configuration.

The API Ingestion tab displays REST API endpoint documentation including the endpoint URL, authentication method using API key in the Authorization header, request format as JSON with transaction array, required fields for each transaction, and example request payload. Users can test the API integration using the built-in test console by entering sample transaction data and clicking "Send Test Request". The console displays the API response including status code, response body, and processing time.

API keys are managed through the API Keys section, allowing users to create new keys, view existing keys with creation date and last used timestamp, and revoke keys that are no longer needed. Each API key is associated with a specific organization and channel, ensuring proper data isolation and security. All API ingestion activities are logged in the ingestion logs viewer showing timestamp, endpoint, method, status code, payload hash, and processing time.

The SFTP Configuration tab enables setup of automated file polling from SFTP servers. Users create SFTP credentials by clicking "Add SFTP Connection" and entering connection details including host address, port number (default 22), username, password or private key for authentication, remote path for file location, file pattern for matching files like "transactions_*.csv", archive path for processed files, target channel for ingested transactions, and polling interval in minutes.

The platform provides a "Test Connection" button to verify SFTP credentials before saving. The test attempts to connect to the SFTP server, list files in the remote path, and confirm write access to the archive path. Upon successful connection test, users can enable polling to activate automated file ingestion. The SFTP polling service runs in the background, checking for new files at the configured interval, downloading matching files, validating and processing transaction data, moving processed files to the archive path, and logging all activities in the ingestion logs.

SFTP credentials are encrypted using AES-256-GCM before storage in the database, ensuring secure handling of sensitive authentication information. Users can view, edit, or delete SFTP connections through the configuration interface. All SFTP activities including connection tests, file downloads, and processing results are logged in the audit trail for security monitoring and compliance purposes.

### 6.5 AI-Powered Anomaly Detection

The AI-Powered Anomaly Detection feature identifies suspicious transactions that may indicate fraud, data quality issues, or system errors. The detection engine employs multiple methods including statistical analysis using Z-score and IQR for amount outliers, pattern-based detection for unusual time patterns and frequency spikes, and LLM-based semantic analysis for suspicious transaction descriptions.

Users access anomaly detection results through the Anomaly Detection page in the sidebar. The interface displays flagged transactions with anomaly scores ranging from 0 to 100, detection methods that identified the anomaly, flagging timestamp, and quick action buttons. Transactions are sorted by anomaly score with highest scores appearing first, indicating the most suspicious transactions requiring immediate attention.

Each flagged transaction card shows transaction details including ID, date, amount, channel, and description, the anomaly score and detection method, the specific reason for flagging such as "Amount 5.2 standard deviations above mean" or "Unusual transaction time: 3:47 AM", and action buttons for marking as false positive, confirming as genuine anomaly, or escalating for investigation.

The detection engine runs automatically on all ingested transactions, flagging anomalies in real-time as data is processed. Detection rules can be configured by administrators through the Module Configuration page, allowing customization of statistical thresholds, pattern definitions, and LLM analysis parameters. All anomaly detection activities and user actions are logged in the audit trail for compliance and quality assurance purposes.

---

## 7. Administration and Configuration

### 7.1 User Management

Administrators manage user accounts through the User Management page accessible from the Admin menu. The interface displays a list of all users with columns showing full name, email address, role (Administrator or User), status (Active or Inactive), last login timestamp, and action buttons for editing or deactivating users.

Creating a new user involves clicking "Add User" and entering the user's email address and assigned role. The platform sends an invitation email to the user with a unique login link. Upon first login, the user completes their profile information and gains access to the platform based on their assigned role. Administrators can edit user details by clicking the edit button, allowing changes to name, role, and status. User accounts can be deactivated without deletion to preserve audit trail integrity, ensuring that historical actions remain attributed to the correct user.

The user management interface includes search and filtering capabilities, allowing administrators to find users by name or email, filter by role or status, and sort by any column. Bulk actions enable administrators to deactivate multiple users simultaneously, useful for offboarding scenarios or organizational restructuring. All user management activities including user creation, role changes, and deactivation are logged in the audit trail for security monitoring and compliance purposes.

### 7.2 System Configuration

System configuration settings are accessed through the Admin menu, providing administrators with control over platform-wide parameters. The configuration interface is organized into several sections including matching engine defaults, data retention policies, notification settings, and integration parameters.

Matching engine defaults specify the initial values for amount tolerance, date window, and confidence threshold used when creating new reconciliation jobs. Administrators can adjust these defaults based on organizational requirements and data characteristics. Data retention policies define how long transaction data, reconciliation results, and audit logs are retained before archival or deletion. Notification settings configure email sender information, SMTP server details if using custom email infrastructure, and notification templates for various system events.

Integration parameters include API rate limits to prevent abuse, webhook retry policies for failed deliveries, and SFTP polling intervals for automated ingestion. Administrators can also configure currency exchange rates for cross-currency reconciliation, though the platform supports automatic rate updates from external sources. All configuration changes are versioned and logged in the audit trail, ensuring that system behavior changes are fully traceable.

### 7.3 Audit Trail Management

The Audit Trail provides comprehensive logging of all system activities for compliance, security monitoring, and troubleshooting purposes. Administrators access the audit trail through the Audit Trail page in the sidebar. The interface displays a chronological log of events with columns showing timestamp, user, action type, entity affected, details, and IP address.

The audit trail captures multiple event categories including authentication events such as login, logout, and failed login attempts, data operations including transaction upload, reconciliation job creation, and exception resolution, configuration changes such as user role modifications, system setting updates, and module configuration changes, and integration activities including API calls, webhook deliveries, and SFTP file transfers.

Advanced filtering capabilities allow administrators to search the audit trail by date range, user, action type, entity type, and keyword search in details. Export functionality enables downloading audit trail data in CSV or Excel format for external analysis or regulatory reporting. The audit trail retention period is configurable through system settings, with a recommended minimum of 7 years for financial compliance requirements.

### 7.4 Module Configuration

Module configuration is accessed through Admin > Module Configuration, providing administrators with control over which reconciliation modules are enabled for the organization. The interface displays all three modules with toggle switches, configuration panels, and usage statistics.

Each module configuration panel includes a module description explaining the purpose and use cases, an enable/disable toggle switch, module-specific settings for matching parameters and exception categories, usage statistics showing job count and transaction volume, and a save button to apply configuration changes. Administrators can enable or disable modules based on organizational needs, with changes taking effect immediately for new reconciliation jobs.

Module-specific settings allow deep customization of reconciliation behavior. For Transaction Integrity Reconciliation, settings include false positive detection rules, duplicate detection sensitivity, and reversal detection patterns. For Settlement Reconciliation, settings include settlement window schedules, processor-specific templates, and merchant grouping rules. For Account-Level Reconciliation, settings include GL integration endpoints, balance validation frequency, and audit trail retention.

All module configuration changes are versioned and logged in the audit trail, ensuring that changes to reconciliation logic are fully traceable. Administrators can view configuration history by clicking "View History" in the module panel, displaying previous configurations with timestamps and user information. This versioning capability is critical for compliance and troubleshooting, allowing administrators to understand how reconciliation behavior has evolved over time.

---

## 8. API and Integrations

### 8.1 REST API Overview

ReconcileAI provides a comprehensive REST API for programmatic access to platform functionality, enabling integration with external systems and automation of reconciliation workflows. The API follows RESTful design principles with JSON request and response formats, standard HTTP methods (GET, POST, PUT, DELETE), and conventional HTTP status codes for success and error responses.

API authentication uses API keys passed in the Authorization header with the format "Bearer {api_key}". Users generate API keys through the Integrations page in the platform interface. Each API key is associated with a specific organization and channel, ensuring proper data isolation and security. API keys should be treated as sensitive credentials and stored securely, never committed to version control or exposed in client-side code.

The API base URL follows the pattern "https://{domain}/api/v1" where {domain} is the platform deployment domain. All API requests must use HTTPS for secure transmission. The API supports pagination for list endpoints using query parameters "page" and "pageSize" with a maximum page size of 500 records. Rate limiting is enforced at 1000 requests per hour per API key to prevent abuse and ensure fair resource allocation.

### 8.2 Transaction Upload API

The Transaction Upload API endpoint allows programmatic submission of transaction data for reconciliation. The endpoint accepts POST requests to "/api/v1/transactions/upload" with a JSON payload containing transaction array and metadata. Required fields for each transaction include transactionId as a unique identifier, date in ISO 8601 format, amount as a numeric value, currency as a three-letter ISO code, reference as a transaction reference number, description as transaction details, and channel indicating the payment channel.

Example request payload demonstrates the expected format with an array of transaction objects. The API validates all required fields, data types, and business rules before accepting the upload. Validation errors return a 400 Bad Request status with detailed error messages indicating which fields failed validation and why. Successful uploads return a 201 Created status with a response body containing uploadId for tracking, transactionCount indicating the number of transactions processed, status showing "processing" or "completed", and any validation warnings.

The API processes uploads asynchronously, allowing clients to submit large batches without waiting for full processing. Clients can poll the upload status endpoint "/api/v1/uploads/{uploadId}" to check processing progress and retrieve final results. The upload API supports idempotency through file hash calculation, preventing duplicate processing of the same data file. If a file with the same hash is uploaded multiple times, the API returns the original upload result without reprocessing.

### 8.3 Reconciliation Job API

The Reconciliation Job API provides programmatic control over reconciliation job creation, monitoring, and result retrieval. Creating a reconciliation job requires a POST request to "/api/v1/reconciliation/jobs" with a JSON payload specifying job configuration including jobName, sourceChannelId, targetChannelId, moduleType, and matching engine parameters such as amountTolerance, dateWindowDays, and confidenceThreshold.

The API returns a job ID upon successful creation, which clients use to monitor job progress and retrieve results. Job status is queried through GET "/api/v1/reconciliation/jobs/{jobId}" returning current status, progress percentage, elapsed time, and preliminary results if available. Job results are retrieved through GET "/api/v1/reconciliation/jobs/{jobId}/results" returning detailed matching outcomes including matched transactions, unmatched transactions, exceptions by category, and summary statistics.

The API supports filtering and pagination of job results, allowing clients to retrieve specific subsets of data such as exceptions only or unmatched transactions only. Query parameters include status for filtering by match status, category for filtering exceptions by category, page and pageSize for pagination, and sortBy and sortOrder for result ordering. This flexibility enables efficient integration with external systems that may only need specific reconciliation outcomes.

### 8.4 Webhook Integration

Webhooks enable real-time notifications of reconciliation events to external systems, eliminating the need for continuous polling. Users configure webhooks through the Integrations page by clicking "Add Webhook" and specifying the webhook URL, events to subscribe to, and authentication method. Supported events include reconciliation job completed, exception created, anomaly detected, and scheduled task executed.

When a subscribed event occurs, the platform sends an HTTP POST request to the configured webhook URL with a JSON payload containing event type, timestamp, organization ID, and event-specific data such as job ID and results summary for job completed events. The webhook endpoint must return a 200 OK status within 30 seconds to acknowledge receipt. If the endpoint fails to respond or returns an error status, the platform retries the webhook delivery up to 3 times with exponential backoff.

Webhook security is ensured through HMAC signature verification. Each webhook request includes an X-Signature header containing an HMAC-SHA256 signature of the request body using a secret key provided during webhook configuration. Receiving systems should verify this signature before processing the webhook payload to ensure authenticity and prevent spoofing. The platform also supports basic authentication and bearer token authentication for webhook endpoints requiring additional security.

Webhook delivery logs are maintained in the Integrations page showing timestamp, event type, URL, status code, response time, and retry count. Users can view detailed request and response data for troubleshooting webhook integration issues. Webhooks can be toggled active or inactive without deletion, preserving configuration and history. All webhook activities are logged in the audit trail for security monitoring and compliance purposes.

### 8.5 SFTP Integration

SFTP integration enables automated file-based data ingestion from external systems without manual upload or API integration. Organizations configure SFTP connections through the Integrations page by providing server credentials, file paths, and polling settings. The platform supports both password and private key authentication for maximum compatibility with different SFTP server configurations.

The SFTP polling service runs in the background, checking for new files at the configured interval. When new files matching the specified pattern are detected, the service downloads them, validates the file format and content, processes transactions into the platform, moves processed files to the archive path, and logs all activities in the ingestion logs. This fully automated workflow eliminates manual intervention for recurring data feeds.

File naming conventions and format requirements should be coordinated with the data source to ensure successful processing. The platform supports CSV and Excel formats with the same column requirements as manual uploads. Files should include a timestamp or sequence number in the filename to ensure proper ordering and prevent duplicate processing. The archive path should be monitored periodically to manage disk space, as processed files accumulate over time.

SFTP integration is particularly valuable for organizations with legacy systems that cannot support REST API integration or for batch data feeds generated by scheduled jobs in external systems. The platform's SFTP capabilities provide a bridge between traditional file-based workflows and modern reconciliation automation.

---

## 9. Troubleshooting and FAQ

### 9.1 Common Issues and Solutions

**Issue: File upload fails with "Invalid file format" error**

This error occurs when the uploaded file does not meet the required format specifications. Ensure the file is in CSV or Excel format with the correct file extension. Verify that all required columns are present including Transaction ID, Date, Amount, Currency, Reference, Description, and Channel. Check that column names match exactly, as the parser is case-sensitive. Ensure there are no empty rows at the beginning of the file, as this can cause parsing errors. If using Excel format, ensure the data is in the first sheet of the workbook.

**Issue: Reconciliation job shows low match rate**

Low match rates can result from several factors. First, verify that the source and target datasets cover the same time period and transaction scope. Check the matching engine parameters, particularly amount tolerance and date window, to ensure they are appropriate for the data characteristics. Review a sample of unmatched transactions to identify patterns such as systematic date differences, amount format inconsistencies, or missing reference numbers. Consider adjusting the confidence threshold if fuzzy matching is too strict. If the data includes cross-currency transactions, ensure currency conversion is enabled and exchange rates are current.

**Issue: Exceptions not appearing in the review queue**

Exceptions may not appear if they are filtered by the current view settings. Check the filter controls at the top of the Exceptions page to ensure no filters are active that would exclude the expected exceptions. Verify that the reconciliation job completed successfully and generated exceptions by viewing the job results page. Ensure the user has appropriate permissions to view exceptions for the relevant channels. If using role-based access control, confirm that the user's role includes exception review permissions.

**Issue: Scheduled task not executing at expected time**

Scheduled task execution depends on correct cron expression configuration and timezone settings. Verify the cron expression using an online cron validator to ensure it represents the intended schedule. Check the timezone setting for the schedule, as execution times are relative to the specified timezone. Ensure the schedule is marked as active, as inactive schedules will not execute. Review the schedule run history to check for error messages or failed executions that may indicate configuration issues. If the schedule has never executed, verify that the source and target channels have sufficient data for reconciliation.

**Issue: Email reports not being received**

Email delivery issues can stem from several causes. Verify that the email addresses in the report configuration are correct and do not contain typos. Check the spam or junk folder, as automated emails may be filtered by email providers. Ensure the email report schedule is active and configured with the correct frequency. Review the email settings page to confirm that report generation is enabled. If using a custom SMTP server, verify the server configuration and authentication credentials. Check the audit trail for email sending events to confirm that the platform attempted to send the report.

**Issue: API authentication failing with 401 Unauthorized**

API authentication failures typically result from incorrect or expired API keys. Verify that the API key is included in the Authorization header with the correct format "Bearer {api_key}". Check that the API key has not been revoked through the API Keys management page. Ensure the API key is associated with the correct organization and has permissions for the requested operation. If the API key was recently created, allow a few minutes for propagation through the system. Review the API documentation to confirm that the endpoint requires API key authentication rather than OAuth authentication.

### 9.2 Frequently Asked Questions

**Q: What file formats are supported for transaction upload?**

ReconcileAI supports CSV (Comma-Separated Values) and Excel (XLS and XLSX) file formats for transaction upload. CSV files should use comma as the delimiter and may optionally include a header row with column names. Excel files should have transaction data in the first sheet of the workbook. Both formats must include the required columns: Transaction ID, Date, Amount, Currency, Reference, Description, and Channel. The maximum file size is 10MB, and the maximum batch size is 5,000 transactions per upload.

**Q: How does the AI matching engine work?**

The AI matching engine employs a three-pass algorithm to maximize match accuracy. Pass 1 performs exact matching on transaction ID, reference number, amount, and date, identifying perfect matches with 100% confidence. Pass 2 applies tolerance-based matching using configurable amount tolerance (default ±0.5%) and date window (default ±3 days), matching transactions within acceptable variance thresholds. Pass 3 executes fuzzy matching on description and reference fields using text similarity algorithms, assigning confidence scores based on how closely the fields match. The engine also incorporates LLM-powered analysis for ambiguous cases, providing intelligent match suggestions with explanations.

**Q: Can I reconcile transactions in different currencies?**

Yes, ReconcileAI supports multi-currency reconciliation across 15 African currencies plus major international currencies including NGN, USD, EUR, GBP, ZAR, KES, GHS, EGP, TZS, UGX, XOF, XAF, MWK, ZMW, and RWF. When creating a reconciliation job with cross-currency transactions, enable the "Currency Conversion" option and specify the base currency for comparison. The platform uses current exchange rates to normalize amounts before matching. Currency mismatches are automatically categorized as exceptions for manual review, ensuring that cross-currency discrepancies are properly handled.

**Q: How long is reconciliation data retained?**

Data retention periods are configurable by administrators through the system settings. The default retention period is 7 years for transaction data, reconciliation results, and audit logs to comply with financial regulatory requirements. Administrators can adjust retention periods based on organizational policies and regulatory obligations. Data approaching the retention limit is automatically archived to long-term storage before deletion. Users can request restoration of archived data through administrator support if historical data access is required.

**Q: What is the difference between the three reconciliation modules?**

Transaction Integrity Reconciliation ensures all transactions are accounted for within internal systems, validating that transactions are not lost, duplicated, or corrupted as they flow through multiple internal systems. Settlement Reconciliation validates that bulk settlement amounts match detailed transaction reports, addressing external party settlement validation between banks, processors, and merchants. Account-Level Reconciliation matches bank account balances to transaction reports, ensuring that the sum of all transactions equals the account balance for GL and regulatory compliance purposes. Organizations can enable or disable modules independently based on their specific reconciliation needs.

**Q: Can I customize the matching engine parameters for different channels?**

Yes, matching engine parameters can be customized per reconciliation job, allowing different configurations for different channels. When creating a reconciliation job, users specify amount tolerance, date window, and confidence threshold appropriate for the specific channel characteristics. For example, POS transactions may require tighter amount tolerance due to precise electronic processing, while mobile money transactions may need wider date windows due to network delays. Administrators can also set default parameters per channel through the system configuration, which are automatically applied when creating new jobs for that channel.

**Q: How do I integrate ReconcileAI with my existing systems?**

ReconcileAI provides three integration methods to accommodate different system architectures. The REST API enables programmatic access to all platform functionality, allowing external systems to upload transactions, create reconciliation jobs, and retrieve results through HTTP requests. Webhooks provide real-time event notifications to external systems, eliminating the need for continuous polling. SFTP integration enables automated file-based data ingestion from legacy systems that cannot support REST API integration. Organizations can use one or multiple integration methods based on their specific requirements and technical capabilities.

**Q: What happens if a reconciliation job fails?**

If a reconciliation job fails during execution, the platform logs the error details in the job record and sends notifications to configured recipients. Users can view the error message and stack trace in the job details page to understand the failure cause. Common failure reasons include invalid data format, missing required fields, database connection issues, or system resource exhaustion. Users can retry failed jobs after addressing the underlying issue. If the failure is due to a system error rather than data issues, contact platform support for assistance. All job failures are logged in the audit trail for troubleshooting and quality monitoring purposes.

**Q: How do I export reconciliation results?**

Reconciliation results can be exported through multiple methods. From the reconciliation job results page, click the "Export" button and select the desired format (CSV or Excel). The export includes all matched transactions, unmatched transactions, and exceptions with full details. For automated exports, configure email reports through the Email Settings page to receive scheduled reports in PDF or Excel format. The REST API also provides export functionality through the job results endpoint, allowing programmatic retrieval of reconciliation outcomes. Exports include summary statistics, detailed transaction listings, and exception categorization for comprehensive reporting.

**Q: Can multiple users work on the same reconciliation job?**

Yes, multiple users can collaborate on reconciliation jobs through the exception review workflow. When one user opens an exception for review, the platform marks it as "In Review" to prevent duplicate work by other users. Other users can see that the exception is being reviewed and by whom, avoiding conflicts. Once the first user completes their review and takes action, the exception is removed from the queue or marked as resolved. This collaborative workflow is particularly valuable for large reconciliation jobs with hundreds of exceptions requiring distributed review across a team.

### 9.3 Getting Help and Support

For additional assistance beyond this user guide, ReconcileAI provides multiple support channels. The in-platform help system is accessible through the question mark icon in the top right corner, providing context-sensitive help articles and video tutorials. Users can search the help system by keyword or browse by topic to find relevant documentation.

Technical support is available through email at support@reconcileai.com for general inquiries and troubleshooting assistance. For urgent issues affecting production reconciliation workflows, users can contact priority support through the platform interface by clicking "Contact Support" in the help menu. Priority support requests receive response within 4 business hours during standard business hours (Monday-Friday, 9am-5pm WAT).

Platform administrators have access to dedicated account management and technical consultation services. Administrators can schedule consultation sessions to discuss configuration optimization, integration planning, or advanced feature implementation. These sessions are conducted via video conference and can be requested through the admin portal.

The ReconcileAI knowledge base at docs.reconcileai.com provides comprehensive technical documentation including API reference, integration guides, best practices, and troubleshooting articles. The knowledge base is regularly updated with new content based on user feedback and platform enhancements. Users can subscribe to knowledge base updates to receive notifications of new articles and documentation improvements.

For training and onboarding, ReconcileAI offers live webinar sessions covering platform fundamentals, advanced features, and role-specific workflows. Webinar schedules are published on the platform homepage and users can register through the training portal. Recorded webinar sessions are available in the help system for on-demand viewing. Organizations can also request customized training sessions tailored to their specific reconciliation workflows and user roles.

---

## Appendix A: Keyboard Shortcuts

ReconcileAI supports keyboard shortcuts for efficient navigation and common actions. Global shortcuts work from any page: **Ctrl+K** opens the command palette for quick navigation, **Ctrl+/** toggles the help panel, **Ctrl+Shift+N** creates a new reconciliation job, and **Esc** closes modal dialogs and dropdowns.

Dashboard shortcuts include **D** to navigate to Dashboard, **U** to navigate to Upload Data, **R** to navigate to Reconciliation, and **E** to navigate to Exceptions. Exception review shortcuts include **A** to accept the current match, **X** to reject the current match, **F** to mark as false positive, **N** to move to the next exception, and **P** to move to the previous exception.

Search and filter shortcuts include **Ctrl+F** to focus the search input, **Enter** to apply filters, and **Ctrl+Shift+F** to clear all filters. Table shortcuts include **J** to move to the next row, **K** to move to the previous row, **Space** to select the current row, and **Ctrl+A** to select all rows.

## Appendix B: Glossary

**Agentic AI**: Autonomous AI agents that can reason, plan, and execute tasks independently within defined boundaries while keeping humans in control of final decisions.

**Amount Tolerance**: A configurable percentage threshold (default ±0.5%) used in tolerance-based matching to accept transactions with minor amount differences as matches.

**Audit Trail**: Comprehensive log of all system activities including matching decisions, manual interventions, and configuration changes for compliance and troubleshooting purposes.

**Confidence Score**: A numeric value from 0 to 1 indicating the matching engine's confidence that two transactions are counterparties, with higher scores indicating stronger matches.

**Date Window**: A configurable number of days (default ±3 days) used in tolerance-based matching to accept transactions with minor date differences as matches.

**Exception**: A transaction discrepancy flagged for manual review due to missing counterparty, amount mismatch, or timing difference exceeding configured thresholds.

**False Positive**: An exception incorrectly flagged by the system due to timing differences, rounding errors, or system lag that does not represent a genuine discrepancy.

**Fuzzy Matching**: A text similarity algorithm used in Pass 3 of the matching engine to match transactions with similar but not identical descriptions or reference numbers.

**Module**: One of three core reconciliation types (Transaction Integrity, Settlement, Account-Level) that can be independently enabled or disabled based on organizational needs.

**Reconciliation Job**: A configured task that matches transactions between source and target datasets using specified matching engine parameters and module type.

**Settlement Window**: A defined time period for processing settlement transactions, typically occurring 3-4 times per day in modern banking systems (T+0, T+1 cycles).

**Three-Pass Algorithm**: The matching engine's sequential approach using exact matching (Pass 1), tolerance-based matching (Pass 2), and fuzzy matching (Pass 3) to maximize accuracy.

---

**Document Version**: 2.0  
**Last Updated**: February 26, 2026  
**Next Review**: May 26, 2026  
**Feedback**: Please send documentation feedback to docs@reconcileai.com
