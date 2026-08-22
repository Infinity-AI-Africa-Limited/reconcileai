-- Financial-services pilot hardening: every operational exception must have a
-- durable tenant owner.
--
-- Two rules govern this migration, and both were learned the hard way:
--
-- 1. OWNERSHIP FOLLOWS THE RECONCILIATION JOB, NOT THE TRANSACTION.
--    Runtime exception creation derives organizationId from the parent job
--    (server/routers.ts runReconciliation: `runOrganizationId` comes from
--    getReconciliationJob and is refused when null), and migration 0078
--    backfilled this same column from the parent job for exactly that reason.
--    A transaction-first backfill would contradict both: where a transaction
--    and its job belong to different tenants it files the exception against
--    the transaction's tenant, so the row becomes visible to an organisation
--    that did not run the reconciliation and vanishes from the reports of the
--    job that produced it. The job is authoritative; the transaction is only a
--    fallback for rows whose job is missing or itself unattributed.
--
-- 2. UNATTRIBUTABLE ROWS ARE NEVER DESTROYED BY AN AUTOMATED DEPLOY.
--    `pnpm db:migrate` runs unattended as a Railway pre-deploy step and in
--    on-premise bank installations whose data we do not control. An exception
--    is a financial control record; deleting one because a backfill could not
--    name its owner is not a decision a deploy hook may take. This migration
--    therefore ASSERTS that nothing is left unattributable and fails closed,
--    stopping the deploy, if anything is. Draining those rows is a deliberate,
--    operator-run step: scripts/drain-unattributable-exceptions.mjs.
--
-- Every statement is idempotent and safe to re-run.
CREATE TABLE IF NOT EXISTS `exception_ownership_quarantine` (
  `id` int NOT NULL,
  `organizationId` int,
  `jobId` int NOT NULL,
  `transactionId` int NOT NULL,
  `category` varchar(64) NOT NULL,
  `subCategory` varchar(64),
  `severity` varchar(16) NOT NULL,
  `currency` varchar(3) NOT NULL,
  `description` text,
  `suggestedResolution` text,
  `aiAnalysis` text,
  `status` varchar(16) NOT NULL,
  `assignedTo` int,
  `assignedAt` timestamp NULL,
  `assignedBy` int,
  `resolvedBy` int,
  `resolvedAt` timestamp NULL,
  `resolutionNotes` text,
  `cbsStillAnomalous` boolean,
  `cbsVerificationNote` text,
  `userKeptResolved` boolean,
  `createdAt` timestamp NULL,
  `quarantinedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `quarantineReason` varchar(128) NOT NULL,
  PRIMARY KEY (`id`)
);--> statement-breakpoint
-- Rule 1, primary: the owning tenant is the one that ran the job.
UPDATE `exceptions` AS `e`
  JOIN `reconciliation_jobs` AS `j` ON `j`.`id` = `e`.`jobId`
  SET `e`.`organizationId` = `j`.`organizationId`
  WHERE `e`.`organizationId` IS NULL AND `j`.`organizationId` IS NOT NULL;--> statement-breakpoint
-- Rule 1, fallback ONLY: the parent job is gone or itself unattributed, so the
-- transaction is the last remaining evidence of ownership. Migration 0078
-- documented that ~42 exceptions point at a jobId with no surviving job; this
-- recovers those instead of quarantining them.
UPDATE `exceptions` AS `e`
  JOIN `transactions` AS `t` ON `t`.`id` = `e`.`transactionId`
  LEFT JOIN `reconciliation_jobs` AS `j` ON `j`.`id` = `e`.`jobId`
  SET `e`.`organizationId` = `t`.`organizationId`
  WHERE `e`.`organizationId` IS NULL
    AND `t`.`organizationId` IS NOT NULL
    AND `j`.`organizationId` IS NULL;--> statement-breakpoint
-- Rule 2: impact assertion. If any exception still has no derivable owner this
-- INSERT attempts to write NULL into a NOT NULL column, MySQL/TiDB raise
-- error 1048 and the migration — and therefore the deploy — stops before the
-- schema is tightened. Nothing is deleted. The column name IS the operator
-- message, because error 1048 quotes it:
--
--   Column 'run_scripts_drain_unattributable_exceptions_mjs_first' cannot be null
--
-- When there is nothing to drain (the normal case) the SELECT matches no rows,
-- no insert is attempted, and the migration proceeds silently.
CREATE TABLE IF NOT EXISTS `_migration_0084_ownership_assertion` (
  `run_scripts_drain_unattributable_exceptions_mjs_first` varchar(64) NOT NULL
);--> statement-breakpoint
INSERT INTO `_migration_0084_ownership_assertion`
  (`run_scripts_drain_unattributable_exceptions_mjs_first`)
SELECT NULL FROM `exceptions` WHERE `organizationId` IS NULL LIMIT 1;--> statement-breakpoint
ALTER TABLE `exceptions` MODIFY COLUMN `organizationId` int NOT NULL;
