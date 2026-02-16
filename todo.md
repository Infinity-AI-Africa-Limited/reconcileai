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
