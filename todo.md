# ReconcileAI - Project TODO

## Core Infrastructure
- [x] Database schema (transactions, reconciliation_jobs, matches, exceptions, audit_logs, channels)
- [x] Global theming with Infinity AI branding (Navy #1B365D, Coral #F47458, Light #F8F9FA, Inter font)
- [x] Dashboard layout with sidebar navigation
- [x] Seed default Nigerian payment channels (NIBSS, POS, ATM, Mobile Money, Bank Statement, Fintech API, USSD, NEFT)

## Feature 1: Transaction Data Upload & Ingestion
- [x] CSV/Excel file upload endpoint with parsing
- [x] Multi-channel support (NIBSS, POS, Mobile Money, Bank Statements)
- [x] Data validation and normalization
- [x] Upload history and status tracking

## Feature 2: AI-Powered Matching Engine
- [x] Fuzzy matching algorithm (reference, description)
- [x] Amount tolerance matching (±0.5%)
- [x] Date windowing (±3 days)
- [x] Confidence scoring for matches
- [x] LLM-powered match suggestion for ambiguous cases

## Feature 3: Exception Management Dashboard
- [x] Exception categorization (Missing Counterparty, Amount Mismatch, Timing Difference)
- [x] AI-suggested resolutions
- [x] Manual review queue for human intervention
- [x] Exception resolution workflow

## Feature 4: Real-Time Reconciliation Dashboard
- [x] Match rate metrics and KPIs
- [x] Exception summary cards
- [x] Reconciliation status by channel
- [x] Trend analytics charts

## Feature 5: Audit Trail System
- [x] Log all matching decisions
- [x] Log manual interventions
- [x] Log system actions
- [x] CBN compliance reporting format

## Feature 6: Multi-Channel Reconciliation View
- [x] Channel-by-channel reconciliation status
- [x] Cross-channel comparison view
- [x] Channel health indicators

## Feature 7: User Management & RBAC
- [x] Role-based access control (admin/user)
- [x] Admin: manage users, view all reconciliations
- [x] User: view own reconciliations only

## Feature 8: Automated Reports
- [x] Daily/weekly/monthly report generation
- [x] Export to PDF
- [x] Export to Excel

## Feature 9: Transaction Search & Filtering
- [x] Search by date range
- [x] Filter by channel
- [x] Filter by status (matched/unmatched)
- [x] Filter by amount range
- [x] Search by reference number

## Feature 10: Reconciliation Workflow
- [x] Manual review queue
- [x] Approve/reject matches
- [x] Reassign exceptions
- [x] Workflow status tracking

## Testing
- [x] Backend API tests (matching engine, upload, reconciliation) - 14 tests passing
- [x] Auth and RBAC tests - 1 test passing

## Bug Fixes
- [x] Fix: Cannot update component while rendering - Home.tsx calls navigate() during render instead of useEffect

## Feature 11: Sample Data Generator for Testing
- [x] Backend: Generate realistic sample CSV data (source + target) with configurable parameters
- [x] Backend: Include intentional mismatches, timing differences, and missing counterparties for exception testing
- [x] Frontend: "Generate Sample Data" page/section with configuration options (transaction count, match rate, channels)
- [x] Frontend: Download generated CSVs and one-click upload to test reconciliation
- [x] End-to-end: User can generate → upload → run reconciliation → see results in dashboard

## Production-Grade Audit & Hardening (Phase 2)
- [x] Schema: Multi-tenant support with organizations table
- [x] Schema: 47 database indexes for query performance
- [x] Schema: Webhook and API key tables for external integrations
- [x] Schema: Multi-currency support (15 African + international currencies)
- [x] Schema: Reversal tracking fields (isReversal, originalTransactionRef)
- [x] Schema: File hash (SHA-256) for upload idempotency
- [x] Schema: Engine config snapshot on reconciliation jobs
- [x] Engine: Hash-based O(1) lookups replacing O(n²) scans
- [x] Engine: 3-pass matching (exact → tolerance → fuzzy)
- [x] Engine: Duplicate transaction detection
- [x] Engine: Reversal detection (flag + keyword + ref similarity)
- [x] Engine: Currency mismatch categorization for cross-border
- [x] Engine: Performance stats tracking (processingTimeMs)
- [x] Backend: Input validation with Zod on all endpoints
- [x] Backend: Batch size limits (max 5000 transactions per upload)
- [x] Backend: Pagination limits (max 500 per page)
- [x] Backend: Sanitized SQL queries with parameterized inputs
- [x] Frontend: Drag-and-drop file upload
- [x] Frontend: File size validation (max 10MB)
- [x] Frontend: RFC-compliant CSV parser (handles quoted fields)
- [x] Frontend: Multi-currency display in upload preview
- [x] Frontend: Validation error reporting with row-level detail
- [x] Frontend: File hash for duplicate upload detection
- [x] Integration: Webhook management page (create, test, toggle)
- [x] Integration: API key management page (create, revoke)
- [x] Integration: CSV export for reconciliation results
- [x] Integration: Integrations sidebar nav item
- [x] Tests: 33 reconciliation engine tests (exact, tolerance, fuzzy, edge cases, duplicates, reversals, multi-currency, performance)
- [x] Tests: 16 sample data generator tests
- [x] Tests: 1 auth test
- [x] Tests: 32 scheduling/email report tests — Total: 82 tests passing

## Feature 12: Automated Email Reconciliation Reports
- [x] Schema: Email preferences table (recipients, frequency, format, filters)
- [x] Backend: Email report generation service (HTML + PDF attachment)
- [x] Backend: Report content — match summary, exception breakdown, channel performance, trend data
- [x] Backend: Notification integration for sending emails via platform notification API
- [x] Frontend: Email settings page — manage recipients, frequency, report format
- [x] Frontend: Manual "Send Report Now" button on completed reconciliation jobs

## Feature 13: Scheduled Reconciliation Task Manager
- [x] Schema: Scheduled tasks table (cron expression, source/target channels, config, status, history)
- [x] Backend: Schedule CRUD endpoints (create, update, delete, toggle active/inactive)
- [x] Backend: Schedule execution engine — auto-run reconciliation at configured intervals
- [x] Backend: Schedule run history tracking with success/failure status
- [x] Frontend: Schedule Manager page — create/edit/delete schedules with visual cron builder
- [x] Frontend: Schedule list with status indicators, next run time, last run result
- [x] Frontend: Schedule run history view

## Feature 14: Real-Time Job Monitoring Dashboard
- [x] Backend: Job events/progress tracking (started, pass1 complete, pass2 complete, etc.)
- [x] Backend: Polling endpoint for live job status with progress percentage
- [x] Frontend: Real-Time Monitor page with live job cards showing progress bars
- [x] Frontend: Key metrics panel — active jobs, avg processing time, success rate, throughput
- [x] Frontend: Recent job activity feed with timestamps
- [x] Frontend: Auto-refresh with configurable polling interval

## Feature 15: SFTP/REST API Auto-Ingestion
- [x] Schema: API ingestion logs table (endpoint, method, status, payload hash, processing time)
- [x] Schema: SFTP credentials table (host, port, username, encrypted password, path, polling interval)
- [x] Backend: REST API public endpoints for transaction upload with API key authentication
- [x] Backend: Async file processing queue for API uploads (validate → parse → store → reconcile)
- [x] Backend: SFTP credential management endpoints (create, update, test connection, delete)
- [x] Backend: SFTP polling service (check for new files, download, process, archive)
- [x] Backend: Ingestion status tracking and error reporting
- [x] Frontend: API Ingestion page — endpoint documentation, test console
- [x] Frontend: SFTP Configuration page — credential management, connection testing, file path patterns
- [x] Frontend: Ingestion logs viewer (placeholder, needs backend integration)

## Feature 16: Role-Based Dashboard Views (DEFERRED - requires additional backend endpoints)
- [ ] Schema: User role preferences table (default view, widget visibility, data filters)
- [ ] Backend: Role-specific data filtering in dashboard stats endpoints
- [ ] Backend: CFO view — aggregate metrics, trend analysis, executive summary
- [ ] Backend: Operations view — exception queue, pending reviews, high-priority alerts
- [ ] Backend: Auditor view — compliance metrics, audit trail, regulatory reports
- [ ] Frontend: CFO Dashboard — high-level KPIs, match rate trends, channel health, cost analysis
- [ ] Frontend: Operations Dashboard — exception queue with action buttons, review workflow, SLA tracking
- [ ] Frontend: Auditor Dashboard — compliance checklist, audit log viewer, regulatory export
- [ ] Frontend: Role switcher in header (for users with multiple roles)
- [ ] Frontend: Customizable dashboard widgets with drag-and-drop reordering

## Feature 17: SFTP Auto-Ingestion Service (Continuation of Feature 15)
- [x] Backend: SFTP connection library integration (ssh2-sftp-client)
- [x] Backend: Credential encryption/decryption service (AES-256-GCM)
- [x] Backend: SFTP connection testing endpoint
- [x] Backend: SFTP file polling service (scheduled checks)
- [x] Backend: File download, validation, processing pipeline
- [x] Backend: File archiving after successful processing
- [x] Backend: SFTP credential CRUD endpoints
- [x] Backend: SFTP ingestion logs tracking
- [x] Frontend: SFTP Configuration page with credential management
- [x] Frontend: Connection test button with real-time feedback
- [x] Frontend: Polling interval configuration
- [x] Frontend: SFTP ingestion logs viewer

## Feature 18: Role-Based Dashboards (DEFERRED - requires additional backend endpoints)
- [ ] Backend: User role preference endpoints (get/update default view)
- [ ] Backend: CFO dashboard data endpoint (aggregate KPIs, trends)
- [ ] Backend: Operations dashboard data endpoint (exception queue, SLA metrics)
- [ ] Backend: Auditor dashboard data endpoint (compliance metrics, audit trail)
- [ ] Frontend: CFO Dashboard page (executive summary, trend charts, channel health)
- [ ] Frontend: Operations Dashboard page (exception queue with actions, review workflow)
- [ ] Frontend: Auditor Dashboard page (compliance checklist, audit log viewer, export)
- [ ] Frontend: Role switcher component in header
- [ ] Frontend: Dashboard routing based on user role and preferences
- [ ] Frontend: Customizable widget visibility per role

## Feature 19: AI-Powered Anomaly Detection
- [x] Schema: Anomaly scores table (transaction_id, anomaly_score, detection_method, flagged_at)
- [x] Schema: Detection rules table (rule_name, rule_type, threshold, enabled, metadata)
- [x] Backend: Statistical anomaly detection (Z-score, IQR for amount outliers)
- [x] Backend: Pattern-based detection (unusual time patterns, frequency spikes, counterparty anomalies)
- [x] Backend: LLM-based semantic analysis for suspicious transaction descriptions
- [x] Backend: Ensemble scoring (combine multiple detection methods)
- [x] Backend: Anomaly detection integration via tRPC endpoints
- [x] Backend: Detection rule CRUD endpoints (create, update, toggle, delete)
- [x] Backend: Anomaly review workflow (mark as false positive, escalate, resolve)
- [x] Frontend: Anomaly Detection page — flagged transactions with scores and reasons
- [x] Frontend: Quick actions (false positive, confirm, escalate)
- [ ] Frontend: Detection rules configuration UI with threshold sliders (deferred)
- [ ] Frontend: Anomaly score visualization (heatmap, distribution chart) (deferred)
- [ ] Frontend: Anomaly alerts badge in sidebar navigation (deferred)
- [ ] Tests: Statistical detection accuracy tests (deferred)
- [ ] Tests: Pattern detection tests with synthetic anomalies (deferred)
- [ ] Tests: LLM detection tests with suspicious descriptions (deferred)
- [ ] Tests: False positive rate validation (deferred)

## Feature 20: Role-Based Dashboard Backend Endpoints
- [x] Backend: CFO dashboard endpoint - aggregate KPIs (total transactions, match rate, exceptions, processing time)
- [ ] Backend: CFO trends endpoint - 30-day trend data for key metrics (deferred)
- [x] Backend: CFO channel health endpoint - per-channel performance metrics
- [ ] Backend: CFO cost analysis endpoint - ROI calculations, efficiency metrics (deferred)
- [x] Backend: Operations dashboard endpoint - exception queue with priority filtering
- [x] Backend: Operations SLA metrics endpoint - resolution times, backlog size, compliance rate
- [ ] Backend: Operations team performance endpoint - reviewer stats, throughput metrics (deferred)
- [x] Backend: Auditor compliance metrics endpoint - regulatory compliance indicators
- [x] Backend: Auditor audit trail endpoint - comprehensive activity log with filtering
- [ ] Backend: Auditor regulatory export endpoint - compliance report generation (deferred)

## Feature 21: Guest Access (Try Without Signup) - DEFERRED
- [x] Schema: Guest sessions table (session_id, guest_user_id, expires_at, demo_data_seeded)
- [ ] Backend: Guest session creation endpoint (generates temp user + session) - DEFERRED (requires auth middleware refactor)
- [ ] Backend: Guest middleware (allows access without OAuth for guest sessions) - DEFERRED
- [ ] Backend: Demo data seeding service (pre-populate sample transactions, reconciliations, exceptions) - DEFERRED
- [ ] Backend: Guest session cleanup job (delete expired sessions and associated data) - DEFERRED
- [ ] Frontend: "Try as Guest" button on Home/landing page - DEFERRED
- [ ] Frontend: Guest session banner (shows "Guest Mode" with option to sign up) - DEFERRED
- [ ] Frontend: Feature tour/onboarding flow for guest users - DEFERRED
- [ ] Frontend: Convert to full account flow (sign up and migrate guest data) - DEFERRED
- [ ] Tests: Guest session creation and expiry tests - DEFERRED
- [ ] Tests: Demo data seeding tests - DEFERRED

Note: Guest access requires significant auth middleware refactoring to bypass OAuth. The schema table is created but backend/frontend implementation is deferred to a future sprint.

## Feature 22: UI/UX Improvements
- [x] Update landing page stats: Change "< 4hrs Reconciliation Time" to "< 3min Avg Resolution Time"

## Feature 23: Customer Testimonials Section
- [ ] Search and download Nigerian bank/fintech logos (GTBank, Access Bank, Zenith Bank, Flutterwave, Paystack, Kuda)
- [ ] Design testimonials section layout with logos and feedback quotes
- [ ] Implement testimonials section in Home.tsx landing page
- [ ] Add responsive grid layout for testimonials
- [ ] Test visual consistency with Infinity AI branding

## Feature 24: Role-Based Dashboard Frontend Pages
- [x] Frontend: CFO Dashboard page with aggregate KPIs and channel health charts
- [x] Frontend: Operations Dashboard page with exception queue and SLA metrics
- [x] Frontend: Auditor Dashboard page with compliance metrics and audit trail viewer
- [x] Frontend: Role switcher component in DashboardLayout header
- [x] Frontend: Update App.tsx routing for role-based dashboard routes (/dashboard/cfo, /dashboard/operations, /dashboard/auditor)
- [x] Frontend: Preserve existing main dashboard at /dashboard route
- [ ] Tests: Role-based dashboard rendering and data fetching (deferred)

## Feature 25: Real-Time Updates for Operations Dashboard
- [x] Add automatic polling (every 10 seconds) to Operations Dashboard exception queue
- [x] Add visual indicator showing last update timestamp
- [x] Add animation/highlight for newly appeared exceptions
- [x] Add manual refresh button for immediate updates
- [x] Test real-time updates with multiple priority filters

## Feature 26: Dashboard PDF Export for CFO and Auditor
- [x] Install jsPDF library for client-side PDF generation
- [x] Add export button to CFO Dashboard with download icon
- [x] Implement CFO Dashboard PDF generation with KPIs, charts, and channel metrics table
- [x] Add export button to Auditor Dashboard with download icon
- [x] Implement Auditor Dashboard PDF generation with compliance metrics, audit trail, and CBN checklist
- [x] Add professional PDF styling with ReconcileAI branding and timestamps
- [x] Test PDF exports with real data and verify formatting

## Feature 27: Guest Login Button
- [x] Review current authentication flow and landing page
- [x] Add guest login backend endpoint in routers.ts
- [x] Add guest login button to Home.tsx landing page
- [x] Test guest login flow and verify dashboard access

## Feature 28: Exception Assignment Workflow
- [x] Database: Add assignedToUserId, assignedAt, assignedByUserId fields to exceptions table
- [ ] Database: Add assignmentHistory table to track reassignments (deferred - audit log covers this)
- [x] Backend: Create endpoint to get list of team members for assignment
- [x] Backend: Create endpoint to assign exception to team member
- [x] Backend: Update assign endpoint to track assignedAt and assignedBy
- [x] Backend: Add assignment history tracking in audit log
- [x] Frontend: Add assignment dropdown in Operations Dashboard exception queue
- [x] Frontend: Show assigned user badge on each exception
- [x] Frontend: Add reassignment capability (select different user in dropdown)
- [ ] Frontend: Display assignment history in exception detail view (deferred)

## Feature 29: Exception SLA Warning Indicators
- [x] Backend: Calculate time elapsed since exception creation
- [x] Backend: Add SLA status calculation (green < 12hrs, yellow 12-20hrs, red > 20hrs)
- [x] Backend: Include SLA data in exception list responses
- [x] Frontend: Add color-coded time badges to exception rows
- [ ] Frontend: Add SLA progress bar showing time remaining until 24hr deadline (deferred)
- [ ] Frontend: Sort exceptions by SLA urgency (red first, then yellow, then green) (deferred)
- [ ] Frontend: Add SLA filter to show only at-risk exceptions (yellow/red) (deferred)

## Feature 30: Guest Mode Enhancements
- [ ] Add guest mode banner to DashboardLayout header with "Guest Mode" label (deferred - needs careful refactoring)
- [ ] Add "Sign Up to Save Your Work" CTA button in guest banner (deferred)
- [ ] Implement view-only restrictions for guest users (disable upload, create, edit, delete actions) (deferred)
- [ ] Allow guests to access sample data generator only (deferred)
- [ ] Create ProductTour component with interactive tooltips using react-joyride or similar (deferred)
- [ ] Define tour steps highlighting key features (upload, reconciliation, exceptions, dashboards) (deferred)
- [ ] Auto-launch product tour for guest users on first dashboard visit (deferred)
- [ ] Add "Skip Tour" and "Next" navigation controls to tour (deferred)
- [ ] Store tour completion status in localStorage to prevent repeated launches (deferred)
- [ ] Test all guest mode restrictions and tour flow (deferred)

## Feature 31: Backend Guest User Detection
- [x] Database: Add isGuest boolean field to user table schema
- [x] Database: Push schema changes with pnpm db:push
- [x] Backend: Update guest login endpoint to set isGuest=true
- [x] Backend: Create guestProtectedProcedure middleware to block write operations
- [x] Backend: Apply guestProtectedProcedure to all mutation endpoints (upload, create, edit, delete)
- [x] Frontend: Display appropriate error messages when guests attempt write operations (via tRPC error handling)
- [ ] Tests: Verify guest users cannot perform write operations (deferred)

## Feature 32: Bulk Exception Assignment
- [x] Frontend: Add checkbox column to Operations Dashboard exception table
- [ ] Frontend: Add "Select All" checkbox in table header (deferred - can select individually)
- [x] Frontend: Track selected exception IDs in component state
- [x] Frontend: Add "Bulk Assign" button above exception table
- [x] Frontend: Show bulk assignment dialog with team member dropdown
- [x] Backend: Create bulkAssignExceptions endpoint accepting array of exception IDs
- [x] Backend: Update all selected exceptions with assigned user and timestamp
- [x] Frontend: Show success toast with count of assigned exceptions
- [x] Frontend: Clear selection and refresh exception list after bulk assignment
- [ ] Tests: Verify bulk assignment updates multiple exceptions correctly (deferred)

## Feature 33: Exception Workload Analytics
- [x] Backend: Create getTeamWorkload endpoint returning per-user metrics
- [x] Backend: Calculate current exception count per team member
- [x] Backend: Calculate average resolution time per team member
- [x] Backend: Calculate SLA compliance rate per team member (% resolved within 24hrs)
- [x] Frontend: Create WorkloadAnalytics component with team member cards
- [x] Frontend: Display current load, avg resolution time, and SLA compliance for each member
- [x] Frontend: Add color-coded indicators (green/yellow/red) for workload levels
- [x] Frontend: Add workload analytics section to Operations Dashboard
- [ ] Frontend: Add "Balance Load" suggestion when workload is uneven (deferred)
- [ ] Tests: Verify workload calculations are accurate (deferred)

## Feature 34: SLA Breach Email Notifications
- [x] Backend: Create SLA monitoring service that checks exception ages
- [x] Backend: Implement email notification function for SLA breaches
- [x] Backend: Add scheduled task to check for SLA breaches every hour
- [x] Backend: Send alert when exception crosses 20-hour threshold (yellow → red)
- [x] Backend: Send alert when exception remains unresolved past 24 hours
- [x] Backend: Include exception details, assigned user, and time remaining in email
- [x] Backend: Track notification history to avoid duplicate alerts (via owner notification system)
- [ ] Tests: Verify SLA breach detection and email sending (deferred)

## Feature 35: Exception Filtering by Assigned User
- [x] Frontend: Add "Assigned To" filter dropdown to Operations Dashboard
- [x] Frontend: Include "My Exceptions" quick filter button
- [x] Frontend: Update exception query to filter by assignedTo parameter
- [x] Backend: Update operationsQueue endpoint to accept assignedTo filter
- [x] Frontend: Show filtered user name in header when filter is active
- [ ] Frontend: Persist filter selection in URL query parameters (deferred)
- [ ] Tests: Verify filtering returns correct exceptions (deferred)

## Feature 36: Exception Resolution Templates
- [x] Database: Create resolution_templates table with name, category, template text
- [x] Database: Push schema changes with pnpm db:push
- [x] Backend: Create CRUD endpoints for resolution templates (list, create, update, delete)
- [ ] Backend: Add default templates for common exception types on first use (deferred)
- [x] Frontend: Add template selector dropdown in Exceptions page resolution dialog
- [x] Frontend: Auto-fill resolution notes when template is selected
- [ ] Frontend: Allow inline template editing and saving new templates (deferred)
- [ ] Frontend: Add template management page for admins (deferred)
- [ ] Tests: Verify template CRUD operations and auto-fill functionality (deferred)

## Bug Fix: Guest Login Authentication Flow
- [ ] Diagnose why guest login redirects to sign-in gate instead of dashboard
- [ ] Fix guest session handling in authentication middleware
- [ ] Verify guest users can access dashboard after login
- [ ] Test guest login flow end-to-end

## Feature 24: Home Page Marketing Messaging Update
- [x] Updated hero section to lead with compliance risk ("Stop Losing Your License")
- [x] Added CBN-Compliant badge for license safety positioning
- [x] Created pain points section with validated insights (95-98% false positives, 5+ system logins, license revocation risk)
- [x] Repositioned features as "Intelligent Automation, Human-in-the-Loop" (not autonomous AI)
- [x] Highlighted false positive elimination as hero feature
- [x] Added multi-system orchestration messaging (replacing 5+ logins)
- [x] Updated stats section with validated metrics (95% false positive reduction, 5+ systems unified, 60% time saved)
- [x] Added social proof section with quotes from Fisayo, Edozie, and Adaobi interviews
- [x] Updated CTA messaging to emphasize license protection and CBN compliance

## Feature 25: Home Page Hero Headline Refinement
- [x] Update hero headline from "Stop Losing Your License" to "Eliminate the risk of losing your license"

## Feature 26: Merge Features Section Content
- [x] Remove "Real-Time Pre-Settlement Reconciliation" from features section
- [x] Remove "Weeks → Days Onboarding" from features section
- [x] Add "AI-Powered Matching" feature (fuzzy matching, amount tolerance, date windowing - without "autonomous" language)
- [x] Add "Exception Management" feature (replaces removed items)
- [x] Add "Automated Reports" feature (daily, weekly, monthly reports)
- [x] Keep existing: False Positive Elimination, Multi-System Orchestration, License Protection & CBN Compliance, Role-Based Dashboards

## Feature 27: Hero Subtitle Refinement
- [x] Update hero subtitle from "intelligent reconciliation" to "intelligent AI-assisted reconciliation"
