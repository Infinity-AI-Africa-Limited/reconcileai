CREATE TABLE `exception_intelligence_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`shareEnabled` boolean NOT NULL DEFAULT true,
	`consumeEnabled` boolean NOT NULL DEFAULT true,
	`contributorPseudonym` varchar(64),
	`lastSharedAt` timestamp,
	`lastConsumedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `exception_intelligence_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `exception_intelligence_settings_organizationId_unique` UNIQUE(`organizationId`)
);
--> statement-breakpoint
CREATE TABLE `exception_pattern_signatures` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`signatureHash` varchar(64) NOT NULL,
	`exceptionCategory` varchar(64) NOT NULL,
	`amountBucket` enum('0-100k','100k-1m','1m+') NOT NULL,
	`counterpartyType` varchar(64) NOT NULL,
	`deductionType` varchar(64),
	`resolutionActionClass` varchar(48) NOT NULL,
	`outcome` enum('resolved','escalated','rejected') NOT NULL,
	`observationCount` int NOT NULL DEFAULT 1,
	`sharedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `exception_pattern_signatures_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `shared_exception_patterns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`signatureHash` varchar(64) NOT NULL,
	`exceptionCategory` varchar(64) NOT NULL,
	`amountBucket` enum('0-100k','100k-1m','1m+') NOT NULL,
	`counterpartyType` varchar(64) NOT NULL,
	`deductionType` varchar(64),
	`resolutionActionClass` varchar(48) NOT NULL,
	`outcome` enum('resolved','escalated','rejected') NOT NULL,
	`contributorCount` int NOT NULL DEFAULT 0,
	`observationCount` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shared_exception_patterns_id` PRIMARY KEY(`id`),
	CONSTRAINT `shared_exception_patterns_signatureHash_unique` UNIQUE(`signatureHash`)
);
--> statement-breakpoint
ALTER TABLE `cfo_report_schedules` MODIFY COLUMN `reportPeriod` varchar(16) NOT NULL DEFAULT '7d';--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `sequenceNumber` int;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `recordHash` varchar(64);--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `prevRecordHash` varchar(64);--> statement-breakpoint
ALTER TABLE `cbnReportSubmissions` ADD `contentHash` varchar(64);--> statement-breakpoint
ALTER TABLE `cbnReportSubmissions` ADD `signature` text;--> statement-breakpoint
ALTER TABLE `cbnReportSubmissions` ADD `signingKeyFingerprint` varchar(64);--> statement-breakpoint
ALTER TABLE `cbnReportSubmissions` ADD `signedByUserId` int;--> statement-breakpoint
ALTER TABLE `cbnReportSubmissions` ADD `signedAt` timestamp;--> statement-breakpoint
ALTER TABLE `reconciliation_jobs` ADD `multiRunId` varchar(36);--> statement-breakpoint
ALTER TABLE `upload_batches` ADD `detectedFormat` varchar(64);--> statement-breakpoint
CREATE INDEX `idx_eis_org` ON `exception_intelligence_settings` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_eps_org` ON `exception_pattern_signatures` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_eps_sig` ON `exception_pattern_signatures` (`signatureHash`);--> statement-breakpoint
CREATE INDEX `idx_eps_org_sig` ON `exception_pattern_signatures` (`organizationId`,`signatureHash`);--> statement-breakpoint
CREATE INDEX `idx_sep_sig` ON `shared_exception_patterns` (`signatureHash`);--> statement-breakpoint
CREATE INDEX `idx_sep_category` ON `shared_exception_patterns` (`exceptionCategory`);--> statement-breakpoint
CREATE INDEX `idx_audit_org_seq` ON `audit_logs` (`organizationId`,`sequenceNumber`);--> statement-breakpoint
CREATE INDEX `idx_jobs_multirun` ON `reconciliation_jobs` (`multiRunId`);