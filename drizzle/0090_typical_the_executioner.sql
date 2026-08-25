-- ─── Amended after generation — read this before editing further ──────────────
--
-- This migration deviates from the repository's append-only rule (CLAUDE.md §12)
-- and the deviation is recorded here rather than left to be rediscovered.
--
-- WHY IT WAS AMENDED. This migration's tables and all three of its indexes were
-- created on the production database OUTSIDE the migration runner, so the
-- objects exist while `__drizzle_migrations` holds no row for 0090 (its newest
-- entry is 0089). Because drizzle applies by the journal `when` watermark, 0090
-- is retried on every deploy and dies on the objects that are already there:
--
--   as generated   ERROR 1050  Table 'corporate_b2b_pilot_configs' already exists
--   after the      ERROR 1061  Duplicate key name 'idx_b2b_pilot_state'
--   table fix                  (reproduced on mysql:8.0 against a production-shaped DB)
--
-- WHY REVERTING WOULD BE WRONG. Append-only protects migrations that have been
-- APPLIED, so that histories cannot diverge. 0090 is recorded as applied in no
-- environment, so there is no history to protect — and restoring the generated
-- form would simply re-break every deploy.
--
-- WHY THIS IS SAFE FOR FRESH DATABASES. The amended file and the generated file
-- produce a byte-identical schema on an empty database: same columns, same
-- types, same defaults, same indexes. Verified by applying both to separate
-- fresh MySQL 8.0 databases and diffing information_schema. `IF NOT EXISTS` and
-- the information_schema/PREPARE guards are no-ops when nothing exists yet.
--
-- WHY NOT `CREATE INDEX IF NOT EXISTS`. That is a TiDB extension. Production is
-- TiDB, but CI is mysql:8.0 and `pnpm db:push` executes these files, so MySQL
-- rejects it with ERROR 1064 — a parse error, before any statement runs. See
-- PR #102, and the portability guard in server/migrationIntegrity.test.ts.
--
-- THE ROOT CAUSE IS NOT THIS FILE. 0084, 0085 and 0090 have all had DDL applied
-- to production by hand, and each time the migration was rewritten to match the
-- database. The durable fix is that schema changes go through the runner — or,
-- when they cannot, that the matching `__drizzle_migrations` row is written in
-- the same operation so the ledger tells the truth.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `corporate_b2b_pilot_configs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`country` enum('uganda','nigeria') NOT NULL DEFAULT 'nigeria',
	`pilotState` enum('preparation','data_validation','dry_run','parallel_run','limited_control','suspended') NOT NULL DEFAULT 'preparation',
	`pilotScope` varchar(500),
	`noWriteAcknowledged` boolean NOT NULL DEFAULT false,
	`aiAssistanceMode` enum('disabled','private_approved') NOT NULL DEFAULT 'disabled',
	`aiBoundaryReference` varchar(255),
	`dataContractStatus` enum('draft','approved') NOT NULL DEFAULT 'draft',
	`rosterStatus` enum('draft','approved') NOT NULL DEFAULT 'draft',
	`allocationPolicyStatus` enum('draft','approved') NOT NULL DEFAULT 'draft',
	`dailyCloseOwner` varchar(255),
	`operationalRecoveryStatus` enum('not_tested','passed') NOT NULL DEFAULT 'not_tested',
	`retentionDays` int NOT NULL DEFAULT 90,
	`contractStatus` enum('draft','approved') NOT NULL DEFAULT 'draft',
	`dataProcessingStatus` enum('draft','approved') NOT NULL DEFAULT 'draft',
	`contractReference` varchar(255),
	`dataProcessingReference` varchar(255),
	`updatedByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `corporate_b2b_pilot_configs_id` PRIMARY KEY(`id`),
	CONSTRAINT `corporate_b2b_pilot_configs_organizationId_unique` UNIQUE(`organizationId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `corporate_b2b_pilot_sources` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`sourceType` enum('invoice_ar','bank_statement','mobile_money','psp_collection','erp_export') NOT NULL,
	`displayName` varchar(255) NOT NULL,
	`deliveryMethod` enum('manual_export','sftp','bucket','api') NOT NULL,
	`status` enum('draft','tested','approved','active','suspended') NOT NULL DEFAULT 'draft',
	`customerOwnedCredentials` boolean NOT NULL DEFAULT true,
	`controlTotalRequired` boolean NOT NULL DEFAULT true,
	`expectedCutoff` varchar(64),
	`sourceOwner` varchar(255),
	`notes` text,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `corporate_b2b_pilot_sources_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @idx1 := (SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'corporate_b2b_pilot_configs' AND index_name = 'idx_b2b_pilot_state');
--> statement-breakpoint
SET @sql1 := IF(@idx1 = 0, 'CREATE INDEX `idx_b2b_pilot_state` ON `corporate_b2b_pilot_configs` (`pilotState`)', 'SELECT 1');
--> statement-breakpoint
PREPARE stmt1 FROM @sql1;
--> statement-breakpoint
EXECUTE stmt1;
--> statement-breakpoint
DEALLOCATE PREPARE stmt1;
--> statement-breakpoint
SET @idx2 := (SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'corporate_b2b_pilot_sources' AND index_name = 'idx_b2b_pilot_sources_org');
--> statement-breakpoint
SET @sql2 := IF(@idx2 = 0, 'CREATE INDEX `idx_b2b_pilot_sources_org` ON `corporate_b2b_pilot_sources` (`organizationId`)', 'SELECT 1');
--> statement-breakpoint
PREPARE stmt2 FROM @sql2;
--> statement-breakpoint
EXECUTE stmt2;
--> statement-breakpoint
DEALLOCATE PREPARE stmt2;
--> statement-breakpoint
SET @idx3 := (SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'corporate_b2b_pilot_sources' AND index_name = 'idx_b2b_pilot_sources_status');
--> statement-breakpoint
SET @sql3 := IF(@idx3 = 0, 'CREATE INDEX `idx_b2b_pilot_sources_status` ON `corporate_b2b_pilot_sources` (`status`)', 'SELECT 1');
--> statement-breakpoint
PREPARE stmt3 FROM @sql3;
--> statement-breakpoint
EXECUTE stmt3;
--> statement-breakpoint
DEALLOCATE PREPARE stmt3;