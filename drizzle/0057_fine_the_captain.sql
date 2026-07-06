CREATE TABLE `cbn_report_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`reportType` varchar(48) NOT NULL,
	`periodLabel` varchar(64),
	`periodStart` timestamp,
	`periodEnd` timestamp,
	`rowCount` int NOT NULL DEFAULT 0,
	`summary` json,
	`contentHash` varchar(64),
	`signature` text,
	`signingKeyFingerprint` varchar(64),
	`signedAt` timestamp,
	`attestingOfficerName` varchar(255),
	`attestingOfficerTitle` varchar(150),
	`generatedByUserId` int,
	`generatedByName` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cbn_report_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cbn_report_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`institutionName` varchar(255),
	`institutionType` enum('microfinance_bank','commercial_bank','payment_service_bank','merchant_bank','other_financial_institution','fintech','other') NOT NULL DEFAULT 'microfinance_bank',
	`rcNumber` varchar(50),
	`cbnLicenseNumber` varchar(100),
	`cbnInstitutionCode` varchar(50),
	`address` varchar(500),
	`preparedByName` varchar(255),
	`preparedByTitle` varchar(150),
	`attestingOfficerName` varchar(255),
	`attestingOfficerTitle` varchar(150),
	`complianceContactEmail` varchar(320),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `cbn_report_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `cbn_report_settings_organizationId_unique` UNIQUE(`organizationId`)
);
--> statement-breakpoint
CREATE INDEX `idx_cbn_report_runs_org` ON `cbn_report_runs` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_cbn_report_runs_type` ON `cbn_report_runs` (`reportType`);--> statement-breakpoint
CREATE INDEX `idx_cbn_report_settings_org` ON `cbn_report_settings` (`organizationId`);