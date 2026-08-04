ALTER TABLE `exceptions` ADD `organizationId` int;--> statement-breakpoint
ALTER TABLE `matches` ADD `organizationId` int;--> statement-breakpoint
CREATE INDEX `idx_exceptions_org` ON `exceptions` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_matches_org` ON `matches` (`organizationId`);--> statement-breakpoint
-- Backfill the owning tenant from each row's parent reconciliation job.
--
-- Safe to run in the pre-deploy step: matches holds ~16k rows and exceptions
-- ~742, so this is milliseconds, not an online schema change. Re-runnable — the
-- `IS NULL` guard makes it idempotent.
--
-- Rows whose parent job is missing (~2,000 matches, ~42 exceptions point at a
-- jobId with no surviving job) keep organizationId NULL. That is the correct
-- outcome, not a failure: NULL means "legacy / underivable", the same meaning it
-- carries on `transactions`. Inventing an owner for them would be worse than
-- leaving them unattributed.
UPDATE `matches` AS `m`
  JOIN `reconciliation_jobs` AS `j` ON `j`.`id` = `m`.`jobId`
  SET `m`.`organizationId` = `j`.`organizationId`
  WHERE `m`.`organizationId` IS NULL AND `j`.`organizationId` IS NOT NULL;--> statement-breakpoint
UPDATE `exceptions` AS `e`
  JOIN `reconciliation_jobs` AS `j` ON `j`.`id` = `e`.`jobId`
  SET `e`.`organizationId` = `j`.`organizationId`
  WHERE `e`.`organizationId` IS NULL AND `j`.`organizationId` IS NOT NULL;