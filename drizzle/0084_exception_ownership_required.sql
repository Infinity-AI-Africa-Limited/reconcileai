-- Financial-services pilot hardening: every operational exception must have a
-- durable tenant owner. Preserve, do not silently discard, legacy rows whose
-- ownership cannot be derived before enforcing NOT NULL.
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
-- Prefer transaction ownership when available; use the parent job as the
-- fallback. Both updates are idempotent and preserve the source of derivation.
UPDATE `exceptions` AS `e`
  JOIN `transactions` AS `t` ON `t`.`id` = `e`.`transactionId`
  SET `e`.`organizationId` = `t`.`organizationId`
  WHERE `e`.`organizationId` IS NULL AND `t`.`organizationId` IS NOT NULL;--> statement-breakpoint
UPDATE `exceptions` AS `e`
  JOIN `reconciliation_jobs` AS `j` ON `j`.`id` = `e`.`jobId`
  SET `e`.`organizationId` = `j`.`organizationId`
  WHERE `e`.`organizationId` IS NULL AND `j`.`organizationId` IS NOT NULL;--> statement-breakpoint
-- Retain the remaining unattributable legacy records in a quarantine table so
-- they cannot appear in an institution's operational/audit view. INSERT IGNORE
-- makes a restart safe if deployment is interrupted before the subsequent delete.
INSERT IGNORE INTO `exception_ownership_quarantine` (
  `id`, `organizationId`, `jobId`, `transactionId`, `category`, `subCategory`,
  `severity`, `currency`, `description`, `suggestedResolution`, `aiAnalysis`,
  `status`, `assignedTo`, `assignedAt`, `assignedBy`, `resolvedBy`, `resolvedAt`,
  `resolutionNotes`, `cbsStillAnomalous`, `cbsVerificationNote`, `userKeptResolved`,
  `createdAt`, `quarantineReason`
)
SELECT
  `id`, `organizationId`, `jobId`, `transactionId`, `category`, `subCategory`,
  `severity`, `currency`, `description`, `suggestedResolution`, `aiAnalysis`,
  `status`, `assignedTo`, `assignedAt`, `assignedBy`, `resolvedBy`, `resolvedAt`,
  `resolutionNotes`, `cbsStillAnomalous`, `cbsVerificationNote`, `userKeptResolved`,
  `createdAt`, 'legacy exception has no derivable organization owner'
FROM `exceptions`
WHERE `organizationId` IS NULL;--> statement-breakpoint
DELETE FROM `exceptions` WHERE `organizationId` IS NULL;--> statement-breakpoint
ALTER TABLE `exceptions` MODIFY COLUMN `organizationId` int NOT NULL;
