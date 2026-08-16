# ReconcileAI - Project TODO

## Research-Aligned Qwen Serving Profile
- [x] Implement the supplied research recommendation: retain Ollama for CPU-only local development and controlled demonstrations while defining a private, authenticated vLLM serving profile for GPU-enabled bank deployments.
- [ ] Run the private vLLM profile only on a bank-approved GPU host after model artifact approval, image vulnerability scanning and digest pinning, secret-manager configuration, capacity tests, reverse-proxy controls, and formal model-risk approval.
- [x] Make the CPU/Ollama profile a first-class bank deployment path by supporting offline trained-model import, private networking, loopback-only application binding, and an enforced SHA-256 model-artifact verification gate.
- [x] Convert the 90-day research roadmap into accelerated dual-tier execution gates without bypassing model-risk, security, or deterministic-control validation, and cover the published plan with regression validation.
- [x] Merge and quantize the exported synthetic-only Qwen2.5-3B adapter into a checksum-verified GGUF artifact, then validate its import and controlled inference through the local CPU/Ollama stack.
- [x] Use a temporary GPU conversion pod within the approved additional US$5 cap to merge and quantize the synthetic-only Qwen adapter; export the GGUF locally and terminate the pod and volume immediately after validation.
- [x] Restore the local on-premise environment from a known-good configuration, reapply the versioned CPU/Ollama model tag cleanly, and verify all local health checks are green without exposing secrets.
- [x] Verify and record the final RunPod balance after pod `xaj6n5pcoj25op` deletion: the console showed US$7.94 remaining from the US$10 credit balance, evidencing aggregate temporary GPU spend of US$2.06 and compliance with the approved additional US$5 cap.
- [x] Re-run local post-switch regression validation to confirm the active CPU model tag remains available and non-model services are unaffected.
- [x] Add a private MinIO S3-compatible service and idempotent bucket bootstrap to the CPU on-premise profile so file storage remains bank-controlled and `/api/health` can validate green without a public cloud dependency.
- [x] Remove the nested read-only Ollama model mount so the CPU profile starts reliably on Docker Desktop for Windows while retaining the verified offline artifact gate.
- [x] Use checksum syntax compatible with the actual Ollama runtime in the offline model bootstrap and validate the gate through Docker Desktop.
- [x] Mount the verified offline artifact directory into the one-shot model-bootstrap service so its checksum gate and Ollama import can actually execute.
- [x] Bind the Node server explicitly to `0.0.0.0` inside Docker for the internal gateway path; publish host-loopback access only through the validated Nginx gateway while the app itself has no host port.
- [x] Add Docker build exclusions for model artifacts, local deployment data, and temporary conversion files so on-premise app rebuilds remain practical on CPU-only hardware.
- [x] Add a minimal loopback reverse-proxy gateway so Docker Desktop can expose only the app while database, Ollama, and MinIO remain solely on the internal network.

## Dual-Tier Serving — CTO production hardening
- [x] Hold the CPU application back until `model-init` completes successfully, so a failed artifact verification stops the deployment instead of serving a model that was never imported.
- [x] Give the GPU profile the gateway pattern: a container attached only to an `internal: true` network cannot serve a published host port (verified — connection refused), so the GPU stack was starting unreachable.
- [x] Fix the CPU `pull` path, which could not start at all: Compose interpolates `${RECON_MODEL:?}` for every mode regardless of the shell branch. Mode and model now arrive as container environment.
- [x] Remove every default credential (`change-me`) and make each deployment secret a required variable with no fallback.
- [x] Give the application a bucket-scoped MinIO service account instead of the storage root credential, and prove it works at bootstrap. Verified against live MinIO: own-bucket read/write allowed; bucket creation, user administration and cross-bucket access denied.
- [x] Stop loading `.env.onprem` into the application container, so infrastructure secrets stay out of the web app's environment.
- [x] Pin every image through a required variable and ship real registry digests in the env templates; no `:latest` anywhere.
- [x] Pass the vLLM key as environment rather than `--api-key`, and use `MYSQL_PWD` for the database health check — both were exposing secrets in container argv.
- [x] Require an out-of-band `RECON_MODEL_SHA256` in addition to the shipped manifest: a manifest that travels with the artifact cannot authorise its own import.
- [x] Refuse to boot on-premise with a missing, placeholder or too-short `JWT_SECRET`.
- [x] Add `pnpm onprem:preflight`, an offline pre-install validator for both profiles, plus structural (parsed-YAML) deployment-contract tests replacing the substring assertions.
- [x] Stop the evaluation harness reporting a transport failure as a 0% quality score, and let it authenticate against the hardened vLLM endpoint.
- [x] Fix the dataset builder and evaluation harness crashing on Windows consoles (cp1252) — the CPU tier's own target platform.
- [x] Merge adapters on CPU and fail loudly if any LoRA module survives, rather than risking a silently part-tuned checkpoint from `device_map="auto"`.
- [ ] Measure model quality on an institution's human-labelled set inside its environment; the synthetic split cannot support a pilot decision.
- [ ] Capacity-test both tiers on the approved target hosts; rehearse rollback.
- [ ] Reduce the on-premise image to production dependencies only.

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

## Feature 28: Anonymize Interswitch Testimonial
- [x] Change job title from "Payment Processor" to "Reconciliation Lead"
- [x] Change company from "Interswitch" to "A leading payment processor"

## Feature 29: Update Home Page Terminology to Agentic AI-Assisted
- [x] Change "intelligent AI-assisted reconciliation" to "intelligent Agentic AI-assisted reconciliation" in hero subtitle
- [x] Update "Intelligent Automation, Human-in-the-Loop" section title to "Agentic AI Automation, Human-in-the-Loop"

## Feature 30: Implement Three-Module Architecture from PRD v2
- [ ] Update database schema to support three reconciliation modules (Transaction Integrity, Settlement, Account-Level)
- [ ] Create module configuration table for enabling/disabling modules per client
- [ ] Update user roles to support module-specific permissions

## Feature 31: Transaction Integrity Reconciliation Module
- [ ] Create transaction ingestion interface for multiple sources (NIBSS, POS, mobile money, core banking)
- [ ] Implement intelligent matching engine with fuzzy matching, amount tolerance, date windowing
- [ ] Build duplicate detection system (unidirectional and bidirectional)
- [ ] Create timestamp normalization logic
- [ ] Implement amount denomination correction
- [ ] Build false positive classification system (timing differences, rounding, system lag)

## Feature 32: Settlement Reconciliation Module
- [ ] Create settlement file upload interface for processor statements
- [ ] Implement pre-settlement reconciliation workflow
- [ ] Build merchant settlement dashboard showing reconciliation status before payment
- [ ] Create settlement discrepancy detection and alerting
- [ ] Implement settlement approval workflow

## Feature 33: Account-Level Reconciliation Module
- [ ] Create GL account reconciliation interface
- [ ] Implement balance verification across systems
- [ ] Build account-level exception detection
- [ ] Create account reconciliation reporting

## Feature 34: Agentic AI-Assisted Matching Engine
- [ ] Implement three-tier classification system (Perfect Match, No Match, Suspected False Positive)
- [ ] Build reinforcement learning feedback loop (users rate AI accuracy)
- [ ] Create AI confidence scoring for each match
- [ ] Implement pattern recognition for recurring exceptions
- [ ] Build resolution template suggestion system

## Feature 35: Exception Management Workflow
- [ ] Create exception dashboard with categorization (timing, amount, missing transaction, duplicate)
- [ ] Implement exception assignment and collaboration system
- [ ] Build exception resolution workflow with approval chains
- [ ] Create exception comments and notes system
- [ ] Implement exception aging and SLA tracking

## Feature 36: Multi-System Orchestration
- [ ] Create unified dashboard showing all payment channels in one view
- [ ] Implement automated data ingestion from multiple sources (eliminate manual downloads)
- [ ] Build connector framework for NIBSS, Interswitch, UPSL, eTranzact, mobile money platforms
- [ ] Create data source configuration interface

## Feature 37: Audit Trail & CBN Compliance
- [ ] Implement comprehensive audit log for all reconciliation activities
- [ ] Create CBN-compliant reporting templates
- [ ] Build audit confidence scoring dashboard
- [ ] Implement automated regulatory report generation
- [ ] Create audit trail export functionality

## Feature 38: Role-Based Dashboards
- [ ] Create Reconciliation Specialist dashboard (daily operations, exception queue)
- [ ] Build Settlement Officer dashboard (settlement windows, merchant payments)
- [ ] Implement Operations Lead dashboard (team performance, SLA tracking)
- [ ] Create CFO/Compliance dashboard (audit readiness, regulatory metrics)

## Feature 39: Performance Metrics & Analytics
- [ ] Implement false positive rate tracking
- [ ] Create manual matching time reduction metrics
- [ ] Build exception resolution time analytics
- [ ] Implement audit confidence scoring
- [ ] Create ROI dashboard showing time savings and efficiency gains

## Feature 30: Implement Three-Module Architecture from PRD v2
- [x] Update database schema to support three reconciliation modules (Transaction Integrity, Settlement, Account-Level)
- [x] Add moduleType field to reconciliation_jobs table with enum values
- [x] Create module_configurations table for enabling/disabling modules per organization
- [x] Add proper indexes for module queries
- [x] Push database schema changes with pnpm db:push
- [x] Fix TypeScript errors in server/routers.ts (resolution templates query refactoring)
- [x] Fix Drizzle ORM initialization to include schema and mode
- [x] Add module configuration imports to server/db.ts
- [x] Create backend endpoints for module management (list, toggle, updateConfig)
- [x] Update frontend UI to show module selection and configuration
- [x] Create Module Configuration page for admins
- [x] Add module configuration link to admin sidebar menu
- [x] Update reconciliation job creation to support module selection
- [x] Add module type dropdown with descriptions to reconciliation form
- [x] Update backend reconciliation.create endpoint to accept moduleType
- [ ] Add module-specific dashboards and workflows (future enhancement)
- [ ] Display module type badge on reconciliation job list (future enhancement)


## Feature 31: Segment-Specific Landing Pages
- [x] Review PRD v2 segment insights and pain points
- [x] Design landing page structure and component architecture
- [x] Create routing for /banks, /fintechs, /payment-processors
- [x] Implement Banks landing page with audit compliance focus
- [x] Implement FinTechs landing page with scale and efficiency focus
- [x] Implement Payment Processors landing page with multi-processor orchestration focus
- [x] Update main landing page with segment navigation
- [x] Add segment-specific CTAs and value propositions
- [x] Add routes for all segment landing pages
- [x] Test all landing pages and create checkpoint
- [x] Create segment landing page tests
- [x] All 5 tests passed successfully


## Feature 32: Comprehensive User Documentation
- [x] Plan documentation structure and table of contents
- [x] Review all existing platform features and workflows
- [x] Create comprehensive User Guide (73 pages) covering all features
- [x] Document user roles and permissions (Admin, User, Guest)
- [x] Create reconciliation workflow guides (upload, matching, exceptions)
- [x] Document three-module architecture (Transaction Integrity, Settlement, Account-Level)
- [x] Create comprehensive Administrator Guide (58 pages)
- [x] Write troubleshooting guide and FAQ section
- [x] Create Quick Start Guide (12 pages)
- [x] Add documentation page to platform UI
- [x] Add Documentation link to sidebar navigation
- [x] Add route for /documentation
- [x] Test documentation completeness and create checkpoint
- [x] Create documentation tests (5 tests passed)
- [x] Verify all documentation files exist and have comprehensive content


## Feature 33: Update False Positive Rates Across Website
- [x] Search for all instances of "95-98% false positive rates" in codebase
- [x] Update frontend pages (Home.tsx - 4 instances updated)
- [x] Update documentation files (User Guide, Admin Guide, Quick Start)
- [x] Updated ReconcileAI_User_Guide.md (2 instances)
- [x] Updated ReconcileAI_Quick_Start.md (1 instance)
- [x] Update all landing pages (Banks, FinTechs, Payment Processors)
- [x] Update ModuleConfiguration.tsx
- [x] Verify all instances are updated (0 instances of 95-98% remaining in website code)
- [x] Test changes and create checkpoint
- [x] Verified TypeScript compilation (0 errors)
- [x] Verified dev server running successfully
- [x] All false positive rates updated from 95-98% to 35-65%


## Bug Fix: Nested Anchor Tags in Landing Pages
- [x] Fix nested <a> tags in BanksLanding.tsx navigation (3 instances)
- [x] Check and fix similar issues in FinTechsLanding.tsx
- [x] Check and fix similar issues in PaymentProcessorsLanding.tsx
- [x] Verified no nested anchor tags remain in landing pages
- [x] Test all landing pages and create checkpoint
- [x] Verified TypeScript compilation (0 errors)
- [x] Verified dev server running successfully
- [x] All nested anchor tag errors resolved


## Bug Fix: Documentation Page Download and View Links
- [x] Read Documentation.tsx to understand current implementation
- [x] Implement proper download functionality for documentation files
- [x] Create backend endpoint to serve documentation files (docs.download)
- [x] Fix View Online links to display documentation content
- [x] Create DocViewer page for viewing documentation online
- [x] Create routes for viewing each documentation guide online
- [x] Install react-markdown and remark-gfm packages
- [x] Add DocViewer route to App.tsx
- [x] Test all download buttons and view links
- [x] Create and run documentation tests (8 tests passed)
- [x] Verified backend endpoint serves documentation files correctly
- [x] Verified download functionality works
- [x] Verified view online functionality with DocViewer page
- [x] Create checkpoint (version 91fcdd81)
- [x] All documentation download and view functionality working correctly


## Bug Fix: Documentation Buttons Still Not Working
- [x] Check browser console logs for errors when clicking download buttons
- [x] Found error: "Failed to fetch documentation" with 400 Bad Request
- [x] Identified issue: tRPC query format was incorrect (missing batch parameter)
- [x] Fixed Documentation.tsx to use proper tRPC batch format
- [x] Fixed DocViewer.tsx to use proper tRPC batch format
- [x] Check browser console logs for errors when clicking view online buttons
- [x] Test download button functionality in browser - SUCCESS
- [x] Test view online button functionality in browser
- [x] Fixed DocViewer filename construction to handle full filenames from URL
- [x] Fixed routing issues with /docs/:docName paths
- [x] Verified documentation content displays correctly with markdown formatting
- [x] Test all documentation buttons (User Guide, Admin Guide) end-to-end
- [x] Quick Start Guide Download - SUCCESS
- [x] Quick Start Guide View Online - SUCCESS
- [x] User Guide View Online - SUCCESS (73-page guide displaying correctly)
- [x] Administrator Guide View Online - SUCCESS (58-page guide displaying correctly)
- [x] All documentation buttons working correctly
- [x] Verified TypeScript compilation (0 errors)
- [x] Verified dev server running successfully
- [x] Create checkpoint (version e2143670)
- [x] All documentation download and view functionality working correctly


## Bug Fix: Admin Menu Layout Issue
- [x] Read DashboardLayout.tsx to identify admin menu structure issue
- [x] Fix overlapping admin menu items in sidebar
- [x] Added more spacing between regular menu and admin section (mt-2, py-4)
- [x] Improved admin label styling (font-semibold, adjusted opacity)
- [x] Ensured proper spacing and organization of admin section
- [x] Test admin menu display in browser
- [x] Verified ADMIN label is clearly visible with proper spacing
- [x] Verified User Management and Module Configuration are properly organized
- [x] Verified divider line separates regular menu from admin section
- [x] No overlapping or muddled appearance
- [x] Create checkpoint (version 2ddcf15a)
- [x] Admin menu layout issue resolved


## Feature 34: Fix Documentation for Published Website and Add Word Format
- [x] Upload documentation files to S3 for published website access
- [x] Uploaded ReconcileAI_Quick_Start.md to S3: https://files.manuscdn.com/user_upload_by_module/session_file/310419663029108989/XqoRUpsesmquaKWW.md
- [x] Uploaded ReconcileAI_User_Guide.md to S3: https://files.manuscdn.com/user_upload_by_module/session_file/310419663029108989/vGDalcLJIHenxGOX.md
- [x] Uploaded ReconcileAI_Admin_Guide.md to S3: https://files.manuscdn.com/user_upload_by_module/session_file/310419663029108989/UJWSitfkNmYbknnF.md
- [x] Convert Quick Start Guide from markdown to Word (.docx)
- [x] Convert User Guide from markdown to Word (.docx)
- [x] Convert Administrator Guide from markdown to Word (.docx)
- [x] Upload Word documents to S3
- [x] Uploaded ReconcileAI_Quick_Start.docx to S3: https://files.manuscdn.com/user_upload_by_module/session_file/310419663029108989/wQbWtJmZrTsvYFql.docx
- [x] Uploaded ReconcileAI_User_Guide.docx to S3: https://files.manuscdn.com/user_upload_by_module/session_file/310419663029108989/dqZmSHeiUaEqLfiR.docx
- [x] Uploaded ReconcileAI_Admin_Guide.docx to S3: https://files.manuscdn.com/user_upload_by_module/session_file/310419663029108989/xcMlkwIotMjyWZGq.docx
- [x] Update backend docs.download endpoint to serve from S3
- [x] Update backend to support both markdown and Word format downloads
- [x] Added S3 CDN URLs mapping for all 6 documentation files
- [x] Update frontend Documentation page to offer format selection (Markdown/Word)
- [x] Added separate Markdown and Word download buttons
- [x] Reorganized UI to prioritize View Online with download options below
- [x] Test download functionality in dev environment
- [x] Tested Word download button - SUCCESS
- [x] Verified toast notifications appear correctly
- [x] Created comprehensive tests for S3 documentation download (10 tests passed)
- [x] All documentation files (markdown and Word) served successfully from S3
- [x] Create checkpoint (version 5a9a2251)
- [x] Documentation now works on published websites via S3 CDN
- [x] Users can download documentation in Word (.docx) format


## Feature 35: High-Impact Investor Deck
- [x] Research best practices for investor decks that convert
- [x] Research successful pitch deck templates (Sequoia, Y Combinator, etc.)
- [x] Analyzed Y Combinator seed deck template (focus on narrative)
- [x] Analyzed Sequoia Capital 10-slide format (clarity and discipline)
- [x] Researched psychological triggers that convert investors
- [x] Documented Cialdini's 6 principles of influence
- [x] Analyzed loss aversion, social proof, and scarcity principles
- [x] Review ReconcileAI PRD v2 for key insights and data points
- [x] Extracted validated pain points from 3 discovery interviews
- [x] Identified key metrics and value propositions
- [x] Calculated market size (TAM: $500M, SAM: $150M, SOM: $10M)
- [x] Develop narrative arc and content strategy for investor deck
- [x] Applied psychological triggers (loss aversion, social proof, scarcity)
- [x] Created 11-slide structure following Sequoia/YC best practices
- [x] Create slide outline with proven structure (Problem, Solution, Market, etc.)
- [x] Documented detailed content for each slide
- [ ] Design slides with Infinity AI branding and visual impact
- [ ] Include compelling data, metrics, and traction from PRD
- [ ] Add financial projections and investment ask
- [ ] Review and refine deck for maximum conversion potential
- [ ] Present final investor deck


## Feature 35: High-Impact Investor Deck
- [x] Research best practices for investor decks that convert
- [x] Research successful pitch deck templates (Sequoia, Y Combinator, etc.)
- [x] Analyzed Y Combinator, Sequoia Capital, and psychological conversion principles
- [x] Review ReconcileAI PRD v2 for key insights and data points
- [x] Develop narrative arc and content strategy for investor deck
- [x] Created 11-slide structure with validated pain points and market data
- [x] Create slide outline with proven structure (Problem, Solution, Market, etc.)
- [x] Design slides with compelling visuals and data
- [x] Applied psychological triggers (loss aversion, social proof, scarcity)
- [x] Created all 11 slides with Infinity AI branding
- [x] Review and refine deck for maximum impact
- [x] Present final investor deck to user


## Feature 36: Add Missing Slides to Investor Deck
- [x] Add Current State slide showing broken status quo with inefficiencies and gaps
- [x] Add Product-Market Fit slide showcasing validated PMF from discovery interviews
- [x] Reorganize slide order to place new slides in optimal narrative position
- [x] Current State slide inserted at position 3 (after Validation)
- [x] Product-Market Fit slide inserted at position 9 (after Business Model)
- [x] Present updated investor deck to user
- [x] Deck now includes 13 slides total (added 2 new slides)
- [x] Current State slide shows broken status quo with 3 problem areas
- [x] Product-Market Fit slide validates PMF across 3 dimensions


## Feature 37: Update Team Slide with LinkedIn Profiles
- [x] Review Richard Asuquo Anwanakak LinkedIn profile
- [x] Review Dele Olaore LinkedIn profile
- [x] Review Olubunmi Aina LinkedIn profile
- [x] Review Nomso Ebonwu LinkedIn profile
- [x] Review Oghomwen Aigbedion LinkedIn profile
- [x] Review Samuel Obinna LinkedIn profile
- [x] Write impactful 20-word description for each team member
- [x] Created descriptions emphasizing credentials, experience, and value
- [x] Update team slide in investor deck with new descriptions
- [x] Updated team.html with all 6 team members and 20-word descriptions
- [x] Redesigned layout to 3x2 grid showcasing all team members equally
- [x] Present updated investor deck


## Feature 38: Update Team Slide with Revised LinkedIn Information
- [x] Extract credentials from Richard's LinkedIn (Founder CEO)
- [x] Extract credentials from Dele's LinkedIn (Technical Co-Founder, CTO - strong interest)
- [x] Extract credentials from Oghomwen's LinkedIn (Technical Co-Founder, CTO - strong interest)
- [x] Extract credentials from Bunmi's LinkedIn (Sales and GTM Consultant with equity)
- [x] Extract credentials from Nomso's LinkedIn (Sales and GTM Consultant with equity)
- [x] Extract credentials from Samuel's LinkedIn (AI Engineer with equity)
- [x] Write 20-word descriptions for all 6 team members with correct roles
- [x] Emphasized Interswitch connections for credibility across 5 team members
- [x] Update team slide in investor deck with new descriptions and roles
- [x] Updated all 6 team member descriptions with LinkedIn-verified credentials
- [x] Changed roles to reflect actual structure (Technical Co-Founders, Sales/GTM Consultants, AI Engineer)
- [x] Updated subtitle to emphasize "Deep Interswitch expertise meets AI innovation"
- [x] Present updated investor deck


## Feature 39: Add Traction Slide to Investor Deck
- [x] Design traction slide structure (customer pipeline + team interest)
- [x] Research Woodcore, Lapo MFB, and Renmoney MFB for context
- [x] Woodcore: Modern core banking software provider, emerged from stealth in Jan 2025
- [x] Lapo MFB: Leading Nigerian microfinance bank, presence in 27 states
- [x] Renmoney MFB: Digital banking fintech, CBN-licensed microfinance bank
- [x] Create traction slide HTML with professional layout
- [x] Add traction slide to investor deck outline (after team slide, before ask slide)
- [x] Update slide_state.json with new traction slide
- [x] Created two-column layout: Customer Pipeline (3 prospects) + Team Building
- [x] Used stage badges (Advanced Talks, Early Stage) for visual clarity
- [x] Highlighted Lapo MFB as problem validation source
- [x] Added momentum note emphasizing customer demand and team building success
- [x] Present updated investor deck with traction slide


## Feature 40: Generate Presentation Notes for Traction Slide
- [x] Write speaker notes for traction slide
- [x] Deliver notes to user


## Feature 41: Create One-Line Investor Pitch
- [x] Craft compelling one-line description of ReconcileAI
- [x] Created 5 alternative versions with different angles
- [x] Recommended Version 1: License protection + market size + urgency
- [x] Deliver to user


## Feature 42: Write Founder Credibility Narrative (Interswitch Background)
- [x] Review Richard's resume PDF for Interswitch experience details
- [x] Review Richard's LinkedIn profile image for additional context
- [x] Extract key credibility signals from Interswitch background
- [x] 15+ years in fintech, 6+ years at Interswitch (2014-present)
- [x] Divisional Head managing 35+ apps across 25 financial institutions in 10+ countries
- [x] Grew portfolio revenue from ₦1.5bn to ₦2.6bn (+73%)
- [x] Deep domain expertise in mobile banking, payments, reconciliation ecosystem
- [x] Product Faculty certified, Lean Six Sigma Green Belt
- [x] Write compelling founder narrative emphasizing domain expertise
- [x] Created comprehensive founder credibility document
- [x] Emphasized 10+ years inside Interswitch reconciliation ecosystem
- [x] Highlighted 35+ apps across 25 institutions in 10 countries
- [x] Showcased ₦1.5bn → ₦2.6bn revenue growth (+73%)
- [x] Positioned as ultimate founder-market fit
- [x] Deliver credibility narrative to user

## Feature 45: Deploy Product Demo App
- [x] Read existing demo app HTML
- [x] Add demo route to reconcileai webdev project (served at /demo.html)
- [x] Verified 200 OK response at /demo.html
- [ ] Save checkpoint and publish

## Feature: Core Banking Channel
- [x] Add Core Banking channel to database (code: core_banking, type: bank_core)
- [x] Add core_banking to CHANNEL_PREFIXES in sampleDataGenerator.ts with CBS prefix
- [x] Add Core Banking to CHANNELS list in SampleData.tsx UI
- [x] Add core_banking to sampleDataGenerator channel-specific description logic
- [x] Add channels.create procedure to routers.ts for admin channel creation
- [x] Seed Core Banking channel via SQL

## Feature: Corporate B2B Landing Page
- [x] Create /corporate-b2b route and CorporateB2BLanding.tsx page
- [x] Hero section: headline, subheadline, CTA buttons
- [x] Problem section: corporate B2B payment pain points
- [x] Solution section: how ReconcileAI solves them
- [x] Many-to-Many matching explainer section
- [x] Key metrics / ROI section
- [x] CTA section with demo request
- [x] Add link from Home.tsx navigation

## Feature: Many-to-Many Matching Demo in Super Agent
- [x] Add M2M demo tab to SuperAgent.tsx
- [x] Animated step-by-step split of N10M deposit across 3 invoices
- [x] Show confidence scores and reasoning for each split
- [x] HitL approval step for the proposed split

## Feature: Distributor Identity Registry
- [x] Create /distributors route and DistributorRegistry.tsx page
- [x] Add distributors table to drizzle/schema.ts
- [x] Add db helpers for distributor CRUD
- [x] Add tRPC procedures for distributor list, create, update, confirm, addVariant
- [x] Build UI: table with search, filter, status badges, detail panel, alias management
- [x] Add to sidebar navigation

## Feature: Pilot Readiness Scorecard
- [x] Add scorecard widget to Dashboard.tsx
- [x] Five dimensions with visual score bars
- [x] Overall readiness score calculation

## Super Agent Architecture Upgrade (Phase 1)

### Layer 1: Many-to-Many Matching Engine
- [x] Add M2M matching pass to superAgentEngine.ts (one source → many targets, many sources → one target)
- [x] Add semantic reference parser: extract invoice numbers, deduction codes, damage claims from free-text refs
- [x] Add FX variance handler: detect bank-fee deductions (flat fee + percentage) as valid matches
- [x] Extend MatchCandidate type with m2m fields: splitRatio, invoiceIds, deductionType, deductionAmount
- [x] Extend ReconciliationResult with m2mMatches array

### Layer 2: Categorical Exception Classifier
- [x] Upgrade categorizeException to return 12 categories (add: partial_payment, promotional_deduction, fx_bank_fee, split_payment, contra_entry, duplicate_invoice)
- [x] Add LLM-powered diagnosis: structured JSON output with rootCause, shortfall, deductionType, recommendedAction
- [x] Add confidence score to diagnosis
- [x] Store diagnosis in exceptions table (new diagnosis_json column)

### Layer 3: Action Draft Layer
- [x] Add agent_action_drafts table to drizzle schema (exceptionId, actionType, draftContent, status, approvedBy, executedAt)
- [x] Add action generator: for each diagnosed exception, generate a draft action (vendor email / credit note / journal entry / payment allocation)
- [x] Add tRPC procedures: getDrafts, resolveDraft, addMemory, getSimilarCases
- [x] Wire approval workflow into Super Agent UI (Action Drafts Queue tab)

### Layer 4: Semantic Memory Layer
- [x] Add agent_memory table (exceptionId, embeddingText, resolution, outcome, reasoning, createdAt)
- [x] Add memory writer: after each approved action, store reasoning + outcome as a memory record
- [x] Add memory retriever: for new exceptions, find top-K similar past cases using token similarity
- [x] Wire memory retrieval into the LLM diagnosis prompt as context
- [x] Add Memory Layer tab to Super Agent UI with semantic search interface

## Feature: Demo Mode Toggle
- [x] Create demoSeedEngine.ts with realistic Nigerian FMCG distributors, transactions, exceptions, and memory records
- [x] Add demo.status, demo.activate, demo.deactivate tRPC procedures
- [x] Add Demo Mode toggle button to DashboardLayout sidebar footer (amber when active)
- [x] Add amber demo banner in main content area when Demo Mode is active
- [x] All demo data tagged for clean wipe on deactivation

## Feature Batch: Demo & Sales Enhancements

### Memory Layer Demo Seed
- [ ] Seed 12 realistic past resolution records into agent_memory table via demoSeedEngine
- [ ] Add "Load Demo Memory" button to Memory Layer tab in Super Agent workspace
- [ ] Memory records cover: partial payment, FX fee, promotional deduction, split payment, timing difference, duplicate, name variant, contra entry

### Deep Diagnose in Review Queue
- [ ] Add "Deep Diagnose" button to each exception card in ReviewQueue.tsx
- [ ] Call superAgent.diagnose tRPC procedure on click
- [ ] Open diagnosis result in a right-side panel (sheet/drawer) with: root cause, confidence, recommended action, similar past cases
- [ ] Show loading state while diagnosis runs

### Distributor Registry Seed (15 Nigerian Distributors)
- [ ] Seed 15 realistic Nigerian FMCG distributors with name variants, bank accounts, zones, and status in demoSeedEngine
- [ ] Pre-populate registry immediately on Demo Mode activation (not separate step)

### Request Demo Form on Corporate B2B Landing
- [ ] Add "Request Demo" modal/form to CorporateB2BLanding.tsx
- [ ] Fields: company name, contact email, estimated monthly payment volume, message
- [ ] Submit via tRPC mutation that stores lead and notifies owner via notifyOwner
- [ ] Show success confirmation after submission

### Pilot Readiness Scorecard → CSV Import
- [ ] Add "Import Distributors from CSV" button to Pilot Readiness Scorecard widget
- [ ] Button visible when Distributor Name Consistency score < 75%
- [ ] Opens file picker for CSV upload; parses and bulk-inserts into distributors table
- [ ] Show import summary (rows imported, errors)

### Demo Mode Auto-Run Reconciliation
- [ ] After seedDemoData completes, automatically trigger a reconciliation job
- [ ] Return jobId and matchRate in activate mutation response
- [ ] Show match rate in Demo Mode activated toast notification

### Share Demo Link (Guest Token)
- [ ] Add guest_tokens table to schema (token, createdBy, expiresAt, viewCount, isActive)
- [ ] Add demo.createGuestLink tRPC procedure (generates 32-char token, 7-day expiry)
- [ ] Add "Share Demo Link" button to Demo Mode active state in sidebar
- [ ] Guest token route: /demo/:token — read-only dashboard view with demo data
- [ ] Add demo.validateGuestToken public procedure for token verification

## Demo Mode Phase 2 Upgrade
- [ ] Upgrade BrightGoods FMCG seed: 1,000 transactions, 95% match rate, healthy exception profile with plain-language narratives
- [ ] Build Financial Services demo seed engine: LapoMFB + Renmoney MFB, millions of transactions, all payment rails, 95% match rate
- [ ] FinServ demo: plain-language exception narratives and AI recommendations
- [ ] Build separate Demo Dashboard page (/demo-dashboard) isolated from live dashboard
- [ ] Demo Dashboard: FMCG vs Financial Services segment selector with segment-specific KPIs
- [ ] Add Demo Dashboard to sidebar navigation (visible when Demo Mode is active)
- [ ] Update Demo Mode toggle to support two demo types: FMCG and Financial Services

## Demo UX Improvements (Phase 3)
- [ ] Print Demo Report button on Demo Dashboard (browser-native PDF export with print stylesheet)
- [ ] "View Demo Dashboard →" link in the demo banner in DashboardLayout
- [ ] Switch Segment toggle in sidebar Demo Mode panel (FMCG / FinServ when Demo Mode is ON)

## Feature 35: Woodcore POC Enhancements (Round 3)
- [ ] Bulk "Mark All as Acknowledged" action on Layer 2 with reviewer note field
- [ ] Variance trend sparkline in overview stats bar across all runs
- [ ] Shareable read-only URL for a run's Layer 3 report (public token-based route)
- [x] Pre-warm shared demo user at server boot — guests get instant data (no 30-60s wait)

## Feature NDA-1: NDPA/NDPR Compliance (LAPO MFB NDA — Clause 11 & 7)
- [x] Schema: compliance_settings table (org-level DPO contact, retention policy, last audit date, ndpa_compliant flag)
- [x] Schema: data_deletion_requests table (requestedBy, requestedAt, completedAt, certificateUrl, scope)
- [x] Backend: Compliance settings CRUD endpoints (get/update per org)
- [x] Backend: Data deletion endpoint — wipe all org transaction data and generate deletion certificate
- [x] Backend: Breach notification endpoint — log incident and trigger owner notification
- [x] Frontend: Compliance Settings page (DPO contact, retention period, NDPA/NDPR status badges)
- [x] Frontend: Data Deletion workflow — confirm dialog, progress, downloadable deletion certificate
- [x] Frontend: Data minimisation notice on Upload page (banner informing analysts to upload only necessary data)
- [x] Frontend: Breach Notification form (internal incident report with auto-notify to owner)
- [x] Audit log: Ensure all data access events (upload, view, export, delete) are logged with userId, timestamp, IP

## Feature NDA-2: Compliance Gap Fixes (Req #2 & #3)
- [x] Add data minimisation notice banner to Upload page (at point of upload, not just Compliance page)
- [x] Log login events to audit trail (user_login action with userId, IP, timestamp)
- [x] Log logout events to audit trail (user_logout action)
- [x] Log sensitive read events: view transactions, view reports, export CSV/PDF

## Feature: Move to Review Queue Button (Exception Modal)
- [x] Backend: exceptions.moveToReview tRPC procedure (sets status to in_review, assigns to current user, logs audit event, dispatches webhook)
- [x] Frontend: "Move to Review Queue" amber button in Exception modal (visible for open exceptions only)
- [x] Tests: 4 vitest tests for moveToReview procedure (defined, auth guard, invalid id, notes length)

## Feature: Filter "Use Template" by Exception Category
- [x] Backend: resolutionTemplates.list now accepts optional category input — returns only templates matching that category when provided
- [x] Frontend: Exceptions.tsx passes selectedEx.category to the templates query; dropdown shows only relevant templates
- [x] Frontend: Dropdown trigger label shows the active category filter (e.g., "Templates (amount mismatch)")
- [x] Frontend: Empty state message "No templates for this category" when no templates match
- [x] Tests: 6 vitest tests for resolutionTemplates.list (defined, no input, valid category, all categories, invalid category, unauthenticated)

## Feature: Template Auto-Filter Persistence (localStorage)
- [x] Filter defaults to ON — active on first visit and after every logout/login (localStorage key "reconcileai_template_autofilter" defaults to true when absent)
- [x] "Clear filter — show all templates" option at the top of the dropdown; selecting it disables the filter and persists the preference to localStorage
- [x] "Re-enable filter" button appears inline next to the dropdown when the filter is off but the exception has a matchable category — clicking it re-enables the filter and persists the preference
- [x] Filter state is read from localStorage on component mount so it survives page refresh, logout, and login
- [x] Tests: 6 vitest tests for the filter behaviour (all pass)

## Feature: Re-enable filter button — hover animation + tooltip
- [x] Add Tooltip component wrapping the Re-enable filter button with descriptive text
- [x] Add subtle hover animation (scale + icon pulse) to the button

## Feature: Compliance Readiness Assessment (Public Tool)
- [ ] Add compliance_assessments table to drizzle schema
- [ ] Add assessment tRPC procedures (submit, getResult, getByToken)
- [ ] Build ComplianceAssessmentLanding.tsx — landing page with CTA
- [ ] Build ComplianceAssessmentQuiz.tsx — multi-step 5-minute assessment flow
- [ ] Build ComplianceAssessmentResult.tsx — personalised risk score report page
- [ ] Add Compliance Readiness Assessment CTA card to Home.tsx
- [ ] Register routes in App.tsx
- [ ] Write vitest tests for assessment procedures

## Feature: Compliance Readiness Assessment (Public Tool)
- [x] Add compliance_assessments table to drizzle/schema.ts and push migration
- [x] Add assessment.submit tRPC procedure (scoring, AI narrative, token generation, DB persist)
- [x] Add assessment.getByToken tRPC procedure (public, token-based lookup)
- [x] Build ComplianceAssessmentLanding.tsx (dedicated landing page)
- [x] Build ComplianceAssessmentQuiz.tsx (25-question multi-step flow with progress bar)
- [x] Build ComplianceAssessmentResult.tsx (personalised risk score, category bars, AI narrative, action plan)
- [x] Wire routes in App.tsx (/compliance-assessment, /compliance-assessment/quiz, /compliance-assessment/result/:token)
- [x] Add CTA card to Home.tsx after segment cards section
- [x] 8 vitest tests passing (scoring logic, token generation)
- [x] TypeScript: 0 errors

## Feature: Send Demo Invite button (Admin Assessments)
- [ ] Add demoInviteSent column to complianceAssessments schema + db:push
- [ ] Add assessment.sendDemoInvite tRPC procedure (sends personalised HTML email, marks demoInviteSent)
- [ ] Wire "Send Demo Invite" button in AdminAssessments.tsx (shows for rows with email, disabled after sent)

## Feature: Shareable LinkedIn assessment badge
- [ ] Add ShareBadge section to ComplianceAssessmentResult.tsx
- [ ] LinkedIn share link with pre-filled text (score, risk level, tool URL)
- [ ] Copy-to-clipboard embed snippet button

## Feature: Download PDF + Weekly Digest (2026-05-18)
- [x] Add Download PDF button to ComplianceAssessmentResult.tsx (jsPDF, client-side, branded A4 report)
- [x] Add weekly Monday 8 AM WAT heartbeat cron (task_uid: cic7MqEL7sVRfdXkWdEjXb, next: 2026-05-25T07:00Z)
- [x] Add /api/scheduled/weeklyAssessmentDigest endpoint in server/_core/index.ts
- [x] 8 vitest tests passing (PDF filename + digest stats logic)

## Feature: Admin Assessments Table Enhancements (Consented Only + Export CSV)
- [x] Backend: consentOnly filter added to assessment.listAll procedure
- [x] Backend: assessment.exportCsv procedure added (returns CSV string + count, up to 5000 rows, respects all active filters)
- [x] Frontend: "Consented only" quick-filter chip above the table (toggleable, highlighted when active, resets pagination)
- [x] Frontend: "Export CSV" button in header (lazy query, triggers Blob download on data arrival, shows spinner while loading)

## Feature: Bulk Demo Invite + Mark as Contacted CRM Flag
- [x] Schema: Add `markedContacted` boolean column to compliance_assessments table
- [x] Backend: assessment.bulkSendDemoInvites procedure (sends to all consented + not yet invited, returns count)
- [x] Backend: assessment.markContacted procedure (toggle markedContacted flag per token)
- [x] Backend: assessment.countBulkEligible procedure (count for confirmation dialog)
- [x] Frontend: "Bulk Send Invites" button in header with confirmation dialog (shows eligible count, coral CTA)
- [x] Frontend: "Mark as contacted" toggle column in admin table (phone icon, navy when active, optimistic update)
- [x] Frontend: Export CSV includes markedContacted column

## Feature: Contacted Filter Chip + Inline Notes Field
- [x] Schema: Add `adminNotes` text column to compliance_assessments table
- [x] Backend: notContacted filter added to assessment.listAll procedure
- [x] Backend: assessment.updateNotes procedure (update adminNotes per token)
- [x] Backend: adminNotes included in listAll select
- [x] Frontend: "Not yet contacted" quick-filter chip alongside "Consented only"
- [x] Frontend: Inline notes cell in admin table (click-to-edit textarea, save on blur/⌘↵, Esc to cancel)

## Feature: Has Notes Chip + Last Contacted Timestamp
- [x] Schema: Add `lastContactedAt` timestamp column to compliance_assessments table
- [x] Backend: markContacted procedure auto-sets lastContactedAt when contacted=true, clears when false
- [x] Backend: hasNotes filter added to assessment.listAll procedure (adminNotes IS NOT NULL AND != '')
- [x] Backend: lastContactedAt included in listAll select
- [x] Frontend: "Has notes" amber quick-filter chip (third chip alongside Consented only + Not yet contacted)
- [x] Frontend: Relative timestamp shown under phone icon when lastContactedAt is set (e.g. "3 days ago")

## Feature: Follow-up Due Date + Pipeline Stage
- [x] Schema: Add `followUpDueAt` timestamp and `pipelineStage` enum column to compliance_assessments
- [x] Backend: assessment.setFollowUpDue procedure (set/clear followUpDueAt per token)
- [x] Backend: assessment.setPipelineStage procedure (update pipelineStage per token)
- [x] Backend: followUpDueAt + pipelineStage included in listAll select
- [x] Frontend: Date picker cell per row — native date input, saves on change, clears with ✕ button
- [x] Frontend: Overdue rows highlight amber (followUpDueAt < today and stage not Closed Won/Lost)
- [x] Frontend: Pipeline stage dropdown per row (New → Contacted → Demo Booked → Proposal Sent → Closed Won → Closed Lost)
- [x] Frontend: Stage badge with colour coding (grey/blue/amber/purple/emerald/red)
- [x] Frontend: Overdue count summary card replaces Pending Demo Invites

## Feature: CBN Compliance Report Module
- [ ] Schema: cbnReportFrameworks, cbnReportSubmissions, cbnReportFindings, cbnActionPlans tables
- [ ] Backend: cbnCompliance router — listFrameworks, listSubmissions, createSubmission, updateSubmission, submitReport, listFindings, createFinding, updateFinding, listActionPlans, createActionPlan, updateActionPlan, generateAiGapAnalysis, exportReport
- [ ] Frontend: CBNCompliance.tsx — full module with 4 tabs: Dashboard, Report Builder, Findings & Actions, Audit Trail
- [ ] Frontend: Compliance dashboard — summary cards (total reports, pending, overdue, compliance score), submission calendar heatmap, framework health grid
- [ ] Frontend: Report builder — framework selector, period picker, section-by-section form, AI gap analysis panel, submit to CBN workflow
- [ ] Frontend: Findings tracker — create/edit/close findings, severity badges, action plan linkage, due date tracking
- [ ] Frontend: Audit trail — immutable log of all compliance actions with user, timestamp, and change details
- [ ] Frontend: Export — PDF/CSV export of any submission with CBN-formatted layout
- [ ] Nav: Add "CBN Compliance" entry to DashboardLayout sidebar under Compliance section
- [ ] Seed: Pre-populate 8 CBN regulatory frameworks (AML/CFT, Prudential, Capital Adequacy, Liquidity, KYC/CDD, Cybersecurity, IFRS 9, Consumer Protection)

## Feature: CBN Compliance Module (Reconciliation-Scoped Frontend)
- [x] CBNCompliance.tsx page with 4 panels: Threshold Breaches, CBN Returns Export, Regulatory Deadlines, AML/CFT Flag Summary
- [x] All data derived from existing reconciliation/transaction/exception tables — no new data sources
- [x] Route /cbn-compliance registered in App.tsx
- [x] CBN Reports sidebar nav item wired (FileBarChart2 icon in adminMenuItems)
- [x] Seed cbnReportFrameworks with 8 CBN framework reference records (idempotent — available via cbnCompliance.seedFrameworks mutation)

## Feature: CBN Compliance PDF + Submission Log
- [ ] Schema: Add `cbnDeadlineSubmissions` table (frameworkCode, periodLabel, submittedAt, submittedByUserId, submittedByName, notes)
- [ ] Backend: cbnCompliance.markDeadlineSubmitted procedure (upsert per frameworkCode + periodLabel)
- [ ] Backend: cbnCompliance.listDeadlineSubmissions procedure (list all, keyed by frameworkCode)
- [ ] Frontend: "Print Attestation" button on Scorecard tab — opens print-optimised single-page PDF with institution name, date, 4 threshold results, compliance officer sign-off block
- [ ] Frontend: Print stylesheet (print:block / print:hidden) scoped to attestation div
- [ ] Frontend: "Mark as submitted" button per deadline row — opens small dialog (period label + optional notes), saves to DB, turns row green with submitted date
- [ ] Frontend: Submitted rows show green "Submitted [date]" badge and lock the Mark as submitted button

## Feature: CBN Compliance PDF Attestation + Deadline Submission Log

- [x] Schema: Add `cbnDeadlineSubmissions` table (frameworkCode, periodLabel, submittedAt, submittedByName, notes)
- [x] DB migration 0029 applied
- [x] Backend: cbnCompliance.markDeadlineSubmitted procedure (upsert per framework+period, writes audit log)
- [x] Backend: cbnCompliance.listDeadlineSubmissions procedure
- [x] Frontend: Print-to-PDF attestation — hidden print div with CBN-formatted attestation document, threshold table, dual signature lines
- [x] Frontend: "Print Attestation" button in Scorecard tab header (triggers window.print)
- [x] Frontend: "Mark as Submitted" button per deadline row — opens confirmation dialog with optional notes
- [x] Frontend: Submitted rows turn green with submitter name, date, and notes inline
- [x] Frontend: Deadlines tab badge only counts unsubmitted critical deadlines
- [x] Frontend: "Re-submit" ghost button for already-submitted rows

## Feature: Submission History Panel + Email Notification on Submit

- [x] Backend: notifyOwner call in markDeadlineSubmitted (framework name, period, submitter, notes)
- [x] Frontend: Collapsible "Submission History" section at bottom of Deadlines tab
- [x] Frontend: Table columns — Framework, Period, Submitted By, Date, Notes
- [x] Frontend: Empty state when no submissions yet
- [x] Frontend: Collapse/expand toggle with chevron icon and submission count badge
- [x] Frontend: Rows sorted newest-first; submitter avatar with initial; notes truncated with full tooltip

## Feature: Submission Log CSV Export + Dashboard Compliance Badge

- [x] Frontend: "Download CSV" button in Submission History panel header (client-side Blob, no new backend needed)
- [x] Frontend: CSV columns — Framework, Period, Submitted By, Date, Notes; sorted newest-first; RFC-4180 compliant quoting
- [x] Frontend: CBN compliance health badge on main Dashboard page (Compliant/At Risk chip)
- [x] Frontend: Badge derives from dashboard.stats (matchRate ≥95%, exceptionRatio ≤5%, openExceptions ≤50)
- [x] Frontend: Badge links to /cbn-compliance for drill-down; only shown when transaction data exists

## Feature 35: Excel Export for Reports and Exceptions (P0 — Pre-Pilot)
- [x] Install exceljs dependency
- [x] Backend: Add Excel export endpoint for reconciliation reports (xlsx with match summary, exception breakdown, channel performance)
- [x] Backend: Add Excel export endpoint for exception reports (xlsx with all exception fields, AI suggestions, resolution notes)
- [x] Frontend: Update reconciliation report export button to offer PDF / Excel choice (CSV + Excel buttons on job list; PDF + Excel on ReportDetail)
- [x] Frontend: Update exception export button to offer PDF / Excel choice
- [ ] Tests: Excel export endpoint tests

## Feature 36: Audit Trail Excel Export + Freeze Row + Scheduled Excel Email
- [ ] Freeze top row (ws.views frozen) on all existing xlsx workbook sheets
- [ ] Backend: Add auditTrail.exportXlsx procedure (date range, action filter, up to 10K rows)
- [ ] Frontend: Add Export to Excel button to Audit Trail page
- [ ] Backend: Extend CFO report scheduler to generate and attach Excel workbook to scheduled emails

## Feature: Three-Portal Architecture (Segment-Scoped Instances)
- [x] Schema: Add `segment` field to `organizations` table (financial_services | corporate_b2b | super_admin)
- [x] Schema: Add `super_admin` to `users.role` enum (Infinity AI internal staff)
- [x] Backend: `superAdminProcedure` middleware — throws FORBIDDEN for all non-super_admin roles
- [x] Backend: Updated `adminProcedure` to allow `super_admin` role (elevated access)
- [x] Backend: `superAdmin` tRPC router with platformStats, allOrganizations, allUsers, createOrganization, updateOrganizationSegment, promoteToSuperAdmin procedures
- [x] Backend: `db.updateUserRole` updated to accept `super_admin` role
- [x] Frontend: DashboardLayout — `super_admin` nav section (Infinity AI branding, violet accent)
- [x] Frontend: DashboardLayout — `canAccessNav` updated so super_admin sees all nav items + super_admin-only items
- [x] Frontend: DashboardLayout — role label shows "Infinity AI Staff" for super_admin
- [x] Frontend: SuperAdminDashboard page (`/admin/super-admin`) — platform stats, org management, user management, segment assignment, promote-to-super-admin
- [x] Frontend: AdminUsers — `PortalRole` type and `ROLE_META` updated to include `super_admin` entry
- [x] Frontend: AdminUsers — `RoleBadge` renders "Infinity AI Staff" badge for super_admin role
- [x] Tests: 10 superAdmin.test.ts tests — FORBIDDEN enforcement for all non-super_admin roles, elevated access for super_admin

## Portal Context Switcher (Super Admin)
- [x] Add `superAdmin.getOrgContext` tRPC procedure — returns org details + segment by orgId
- [x] Create `client/src/contexts/PortalContext.tsx` — viewAsOrg state (id, name, segment), enterPortal(org), exitPortal(), persisted in sessionStorage
- [x] Add "Enter Portal" button on each org row in SuperAdminDashboard organisations tab
- [x] Add persistent portal banner in DashboardLayout — "Viewing as: {orgName} · {segment}" + Exit button
- [x] Implement segment-aware sidebar: Financial Services shows banking nav; Corporate B2B shows FMCG/distributor nav
- [x] Scope all data queries (reconciliation, exceptions, etc.) to viewAs org when portal context is active
- [x] Create demo org for Corporate B2B segment (BrightGoods Nigeria) in database
- [x] Ensure Financial Services org (Globus Bank Nigeria Demo) has correct segment label
- [x] Save checkpoint and push to both GitHub accounts

## Module Consolidation (Settlement + Account Level only)
- [x] Merge Transaction Integrity into Settlement Reconciliation (capabilities + metrics combined)
- [x] Reduce modules to 2: Settlement Reconciliation and Account-Level Reconciliation
- [x] Update schema: module_configurations enum to settlement|account_level only
- [x] Add module_overrides table for super admin per-institution control
- [x] Add superAdmin.listOrgOverrides, setOrgModuleOverride, clearOrgModuleOverride procedures
- [x] Update ModuleConfiguration.tsx: 2 modules, merged content, Per-Institution button for super_admin
- [x] Per-Institution dialog: force ON/OFF per org with optional reason, clear override option
- [x] Update reconciliation job create default moduleType to settlement

## Financial Services Portal — Email Settings & Advanced Tools
- [x] Add Email Settings (/email-settings) to financialServicesMenuItems
- [x] Add Module Configuration (/modules) to financialServicesMenuItems
- [x] Create financialServicesAdvancedItems array with all 5 Advanced Tools (Sample Data, Integrations, API Ingestion, SFTP Config, Anomaly Detection)
- [x] Update portal nav logic: portalAdvancedItems resolves to financialServicesAdvancedItems when in Financial Services portal
- [x] Refactor Admin section rendering to support portal-only advanced items (no admin section header needed)
- [x] Advanced Tools dropdown visible in Financial Services portal with collapse/expand toggle

## Feature: Mobile Money Reconciliation (Gap 2 — Competitive Intelligence Roadmap)
- [x] Schema: mm_runs table (operator, channel, session tracking fields)
- [x] Schema: mm_exceptions table (8 mobile money exception categories)
- [x] DB migration pushed (mm_runs + mm_exceptions live in production DB)
- [x] Server: mobileMoney-engine.ts — NIP/OPay/Palmpay settlement file parsers
- [x] Server: Mobile money exception taxonomy (8 categories) — open string in EI layer, no changes needed
- [x] Server: Mobile money AI diagnosis prompts with CBN regulatory context (in mobileMoney-engine.ts)
- [x] Server: Flywheel integration — mm exception categories wired into captureResolutionPattern
- [x] Server: tRPC procedures — run, getRuns, getExceptions, updateStatus (server/routers/mobileMoney.ts)
- [x] Frontend: MobileMoneyPOC.tsx — standalone page at /mobile-money-poc
- [x] Frontend: Operator selector (NIP / OPay / Palmpay)
- [x] Frontend: File upload + Layer 1/2/3 results display
- [x] Frontend: Exception list with AI diagnosis panel and resolution workflow
- [x] Frontend: 5 mobile money KPI benchmark keys + computation wired into LAPO KPI dashboard
- [x] Tests: mobileMoney.test.ts — taxonomy, operator metadata, KPI benchmarks, amount mismatch, duplicate detection (26 tests)

## Phase 0 — SHOPLINE Retail Vertical Extension

- [x] Task 0.1: Add `retail_commerce` segment to organizations schema
- [x] Task 0.2: Add SHOPLINE onboarding channel constants (shared/shoplineConstants.ts)
- [x] Task 0.3: Define retail exception taxonomy (server/exceptions/retail-commerce.ts)
- [x] Task 0.4: Add retail channel types to channels table schema
- [x] Task 0.5: Extend Super Admin portal with vertical selector
- [x] Task 0.6: Write retail reconciliation engine adapter (server/retailReconciliationEngine.ts)

## SHOPLINE Tier 1 — App Store Integration (End-to-End)

### T1-A: Merchant Self-Serve Onboarding (auto-provisioning on install)
- [ ] T1-A1: Build `server/connectors/shopline/onboarding.ts` — auto-create org (segment=retail_commerce, channel=shopline_app_store), admin user, connector config, channels (shopline_payments, shopline_orders), retail resolution-template seed
- [ ] T1-A2: Wire onboarding into OAuth callback — when store is unknown, call onboardShoplineMerchant() to provision tenant
- [ ] T1-A3: Build Express route `GET /api/shopline/install` — validate HMAC sign from SHOPLINE install request, redirect to authorize URL
- [ ] T1-A4: Build Express route `GET /api/shopline/callback` — validate sign, exchange code, provision merchant, redirect to dashboard
- [ ] T1-A5: Build Express route `POST /api/webhooks/shopline` — raw-body HMAC verify, enqueue+ack 200 within 5s
- [ ] T1-A6: Build `client/src/pages/ShoplineConnect.tsx` — install landing + connection status page for merchants
- [ ] T1-A7: Post-install first-run UX — "connected — first sync running" state driven by shoplineConnector.health
- [ ] T1-A8: Build merchant identity via SHOPLINE session — no separate ReconcileAI password, auth derived from SHOPLINE OAuth

### T1-B: Subscription & Billing (Stripe)
- [ ] T1-B1: Add Stripe integration via webdev_add_feature (stripe)
- [ ] T1-B2: Create Stripe Products/Prices for 5 bands: Starter ($49/mo, $490/yr), Growth ($99/mo, $990/yr), Professional ($199/mo, $1990/yr), Scale ($349/mo, $3490/yr), Enterprise (custom)
- [ ] T1-B3: Build subscription state machine: trial(14d) → active → paused → cancelled
- [ ] T1-B4: Build trial flow — 14-day free trial on install, no credit card required
- [ ] T1-B5: Build trial expiry handler — day 12 email prompt, day 14 pause reconciliation (retain data)
- [ ] T1-B6: Build tier auto-assignment based on prior 30 days transaction volume
- [ ] T1-B7: Build annual billing as default (2 months free = ~17% discount)
- [ ] T1-B8: Build subscription upgrade/downgrade flow based on volume changes
- [ ] T1-B9: Build SHOPLINE revenue share tracking — 15% of all subscription revenue, monthly report
- [ ] T1-B10: Build billing portal page for merchants (current plan, usage, invoices, upgrade)
- [ ] T1-B11: Add `subscriptions` table to schema (orgId, stripeCustomerId, stripeSubscriptionId, tier, status, trialEndsAt, currentPeriodEnd, billingInterval)

### T1-C: Retail Merchant Dashboard
- [ ] T1-C1: Build retail-commerce navigation set in DashboardLayout (Dashboard, Reconciliation, Exceptions, Settlement Monitor, Reports, Settings)
- [ ] T1-C2: Build retail Dashboard page — match rate, exception count, settlement status, last sync time
- [ ] T1-C3: Build retail Reconciliation page — order↔payment↔settlement three-leg view
- [ ] T1-C4: Build retail Exceptions page — chargeback tracker, fee variance, settlement shortfall, with AI diagnosis
- [ ] T1-C5: Build retail Settlement Monitor page — payout timeline, expected vs actual, shortfall alerts
- [ ] T1-C6: Build retail Reports page — daily/weekly/monthly reconciliation summary, exportable
- [ ] T1-C7: Build retail Settings page — connected stores, sync frequency, notification preferences, billing
- [ ] T1-C8: Wire segment-based routing — retail_commerce orgs see retail nav, not banking nav

### T1-D: Scheduled Sync Jobs (Polling Fallback + Webhook Reconciler)
- [ ] T1-D1: Build `server/connectors/shopline/subscriptions.ts` — desired-state webhook subscriber (on install + daily: list webhooks, create missing topics from A7, alert if SHOPLINE deleted one)
- [ ] T1-D2: Build polling fallback job — every 15 minutes, poll for new records using updated_at_min watermark
- [ ] T1-D3: Build daily batch sync — full reconciliation run at 02:00 UTC (catches missed webhooks)
- [ ] T1-D4: Build initial 90-day historical pull on first install (background job, paginated)
- [ ] T1-D5: Build watermark tracking — store last sync timestamp per store per entity type
- [ ] T1-D6: Wire sync jobs into Heartbeat SDK (periodic updates skill)
- [ ] T1-D7: Build sync health monitoring — alert if no data received for >1 hour during business hours

### T1-E: GDPR & App Store Compliance
- [ ] T1-E1: Build Express route `POST /api/shopline/gdpr/customers-redact` — customer PII deletion within 30 days
- [ ] T1-E2: Build Express route `POST /api/shopline/gdpr/merchants-redact` — full merchant data deletion (fires 48h after uninstall)
- [ ] T1-E3: Build data retention policy — archive merchant data on uninstall, purge after 30 days per GDPR
- [ ] T1-E4: Ensure webhook receiver acks < 5 seconds (queue-first design already in place)
- [ ] T1-E5: Build privacy policy page at /privacy (SHOPLINE App Store requirement)
- [ ] T1-E6: Build terms of service page at /terms (SHOPLINE App Store requirement)
- [ ] T1-E7: Prepare App Store listing assets — logo 120×120, 3 feature bullets, EN default language, screenshots

### T1-F: Integration Wiring & Engine
- [ ] T1-F1: Build `server/connectors/shopline/ingest.ts` — map SHOPLINE API responses to canonical transaction rows with namespaced dedupe keys
- [ ] T1-F2: Wire SHOPLINE channels (shopline_orders, shopline_payments) into retailReconciliationEngine
- [ ] T1-F3: Build three-leg join matching — order.payment_details[].pay_channel_deal_id ↔ transactions[].channel_deal_id ↔ billing_records.source_order_transaction_id
- [ ] T1-F4: Wire dispute lifecycle (WON/LOST/EXPIRED, pre-chargeback) into existing 25 retail exception categories
- [ ] T1-F5: Inject retailExceptionsTaxonomyPromptBlock into Super Agent for retail_commerce segment orgs
- [ ] T1-F6: Build isSettlementBatchOverdue watchdog using real settlement_batch_ids from billing records

### T1-G: Dependencies & Blockers (Owner Actions Required)
- [ ] T1-G1: SHOPLINE Partner Portal registration — create Public App, obtain app key + app secret
- [ ] T1-G2: Configure App URL + callback URLs in Partner Portal
- [ ] T1-G3: Configure GDPR webhook URLs in Developer Center
- [ ] T1-G4: Create SHOPLINE developer store for end-to-end testing
- [ ] T1-G5: Confirm App Store billing model — platform-managed or ReconcileAI-side (Stripe)
- [ ] T1-G6: Set env vars: SHOPLINE_CLIENT_ID, SHOPLINE_CLIENT_SECRET, SHOPLINE_WEBHOOK_SECRET
- [ ] T1-G7: App Store slot application + listing submission (after all code complete)
- [ ] T1-G8: DPA (Data Processing Agreement) negotiation with SHOPLINE legal
- [ ] T1-G9: Revenue share agreement (15% target) with SHOPLINE

## Financial-Services Operational Demo Data

- [x] Create a feature branch from the latest Infinity-AI code and map the current Transactions, Exceptions, Review Queue and dependent views
- [x] Populate coherent financial-services transaction, exception and review-queue data through the approved demo-data path
- [x] Reflect demo-data outcomes in connected dashboards, monitoring, ageing, reporting, audit and compliance surfaces
- [x] Add or update automated tests for the new financial-services demo-data behaviour
- [x] Run type checks, full tests and production build verification
- [ ] Perform authenticated visual verification after the reviewed build is deployed
- [x] Push the feature branch to both GitHub repositories and open Claude Code review PRs
