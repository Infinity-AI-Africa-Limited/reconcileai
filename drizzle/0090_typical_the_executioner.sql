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
CREATE INDEX `idx_b2b_pilot_state` ON `corporate_b2b_pilot_configs` (`pilotState`);--> statement-breakpoint
CREATE INDEX `idx_b2b_pilot_sources_org` ON `corporate_b2b_pilot_sources` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_b2b_pilot_sources_status` ON `corporate_b2b_pilot_sources` (`status`);