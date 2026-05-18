CREATE TABLE `cbnActionPlans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`findingId` int NOT NULL,
	`organizationId` int,
	`title` varchar(255) NOT NULL,
	`description` text,
	`owner` varchar(255),
	`priority` enum('low','medium','high','critical') NOT NULL DEFAULT 'medium',
	`status` enum('not_started','in_progress','completed','deferred','cancelled') NOT NULL DEFAULT 'not_started',
	`targetDate` timestamp,
	`completedAt` timestamp,
	`evidenceNotes` text,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `cbnActionPlans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cbnAuditLog` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`userId` int,
	`userName` varchar(255),
	`action` varchar(128) NOT NULL,
	`entityType` varchar(64),
	`entityId` int,
	`entityLabel` varchar(255),
	`details` json,
	`ipAddress` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cbnAuditLog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cbnReportFindings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`submissionId` int,
	`frameworkId` int NOT NULL,
	`organizationId` int,
	`findingRef` varchar(64),
	`title` varchar(255) NOT NULL,
	`description` text,
	`category` enum('governance','kyc_cdd','aml_cft','capital_adequacy','liquidity','credit_risk','cybersecurity','ifrs9','consumer_protection','reporting','other') NOT NULL DEFAULT 'other',
	`severity` enum('low','medium','high','critical') NOT NULL DEFAULT 'medium',
	`source` enum('self_assessment','internal_audit','cbn_examination','external_audit','ai_gap_analysis') NOT NULL DEFAULT 'self_assessment',
	`status` enum('open','in_progress','resolved','accepted_risk','closed') NOT NULL DEFAULT 'open',
	`dueDate` timestamp,
	`resolvedAt` timestamp,
	`resolvedByUserId` int,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `cbnReportFindings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cbnReportFrameworks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`regulatoryBasis` text,
	`frequency` enum('daily','weekly','monthly','quarterly','semi_annual','annual','ad_hoc') NOT NULL,
	`submissionDeadlineDays` int DEFAULT 5,
	`isActive` boolean NOT NULL DEFAULT true,
	`sortOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cbnReportFrameworks_id` PRIMARY KEY(`id`),
	CONSTRAINT `cbnReportFrameworks_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `cbnReportSubmissions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`frameworkId` int NOT NULL,
	`periodStart` timestamp NOT NULL,
	`periodEnd` timestamp NOT NULL,
	`reportingPeriodLabel` varchar(64),
	`status` enum('draft','in_review','approved','submitted','acknowledged','queried','closed') NOT NULL DEFAULT 'draft',
	`submittedAt` timestamp,
	`submittedByUserId` int,
	`acknowledgedAt` timestamp,
	`cbNReferenceNumber` varchar(128),
	`submissionChannel` enum('goAML','FinA','email','portal','manual') DEFAULT 'portal',
	`reportData` json,
	`complianceScore` int,
	`aiGapAnalysis` text,
	`aiGapGeneratedAt` timestamp,
	`internalNotes` text,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `cbnReportSubmissions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_cbn_actions_finding` ON `cbnActionPlans` (`findingId`);--> statement-breakpoint
CREATE INDEX `idx_cbn_actions_org` ON `cbnActionPlans` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_cbn_actions_status` ON `cbnActionPlans` (`status`);--> statement-breakpoint
CREATE INDEX `idx_cbn_audit_org` ON `cbnAuditLog` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_cbn_audit_action` ON `cbnAuditLog` (`action`);--> statement-breakpoint
CREATE INDEX `idx_cbn_audit_entity` ON `cbnAuditLog` (`entityType`,`entityId`);--> statement-breakpoint
CREATE INDEX `idx_cbn_audit_created` ON `cbnAuditLog` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_cbn_findings_org` ON `cbnReportFindings` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_cbn_findings_framework` ON `cbnReportFindings` (`frameworkId`);--> statement-breakpoint
CREATE INDEX `idx_cbn_findings_status` ON `cbnReportFindings` (`status`);--> statement-breakpoint
CREATE INDEX `idx_cbn_findings_severity` ON `cbnReportFindings` (`severity`);--> statement-breakpoint
CREATE INDEX `idx_cbn_submissions_org` ON `cbnReportSubmissions` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_cbn_submissions_framework` ON `cbnReportSubmissions` (`frameworkId`);--> statement-breakpoint
CREATE INDEX `idx_cbn_submissions_status` ON `cbnReportSubmissions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_cbn_submissions_period` ON `cbnReportSubmissions` (`periodStart`,`periodEnd`);