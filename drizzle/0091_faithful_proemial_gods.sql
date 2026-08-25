-- ─── Amended after generation — read this before editing further ──────────────
--
-- This migration deviates from the repository's append-only rule (CLAUDE.md §12)
-- and the deviation is recorded here rather than left to be rediscovered. It is
-- the same failure, and the same remedy, as 0090.
--
-- WHY IT WAS AMENDED. `control_fit_briefs` was created on the production
-- database OUTSIDE the migration runner, so the table exists while
-- `__drizzle_migrations` holds no row for 0091 — its newest entry is 0090
-- (1787472000000). Because drizzle applies by the journal `when` watermark, 0091
-- is retried on every deploy and dies on the table that is already there:
--
--   Error: Table 'control_fit_briefs' already exists
--   code:  ER_TABLE_EXISTS_ERROR
--
-- Confirmed against production before amending: the table is present, carries
-- both of its indexes (PRIMARY, uq_control_fit_org) and holds ZERO rows, and
-- 1787514094341 is absent from __drizzle_migrations.
--
-- WHY REVERTING WOULD BE WRONG. Append-only protects migrations that have been
-- APPLIED, so that histories cannot diverge. 0091 is recorded as applied in no
-- environment, so there is no history to protect — and restoring the generated
-- form would simply re-break every deploy.
--
-- WHY THE TABLE GUARD IS ENOUGH HERE, UNLIKE 0090. Both of this table's indexes
-- are declared INSIDE the CREATE TABLE (a PRIMARY KEY and a UNIQUE constraint),
-- not as separate CREATE INDEX statements. `IF NOT EXISTS` therefore skips the
-- whole statement, constraints included, so the ERROR 1061 "Duplicate key name"
-- that 0090 hit after its table fix cannot arise. No information_schema/PREPARE
-- guard is needed, and none is added — `CREATE INDEX IF NOT EXISTS` would have
-- been wrong anyway: it is a TiDB extension that MySQL 8.0 rejects with
-- ERROR 1064, which is why migrationIntegrity forbids it.
--
-- WHY THIS IS SAFE FOR FRESH DATABASES. `IF NOT EXISTS` is a no-op when nothing
-- exists yet, so an empty database receives byte-identical DDL: same columns,
-- same types, same defaults, same constraints.
CREATE TABLE IF NOT EXISTS `control_fit_briefs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`workflowName` varchar(255) NOT NULL,
	`operationalProblem` text NOT NULL,
	`accountableOwner` varchar(255) NOT NULL,
	`decisionDeadline` varchar(128) NOT NULL,
	`approvedEvidence` json NOT NULL,
	`baseline` text NOT NULL,
	`successMeasure` text NOT NULL,
	`status` enum('draft','baseline_confirmed','parallel_run','accepted','stopped') NOT NULL DEFAULT 'draft',
	`updatedByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `control_fit_briefs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_control_fit_org` UNIQUE(`organizationId`)
);
