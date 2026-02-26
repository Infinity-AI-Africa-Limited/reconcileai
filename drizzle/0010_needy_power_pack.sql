CREATE TABLE `module_configurations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`moduleType` enum('transaction_integrity','settlement','account_level') NOT NULL,
	`isEnabled` boolean NOT NULL DEFAULT true,
	`configuration` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `module_configurations_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_org_module` UNIQUE(`organizationId`,`moduleType`)
);
--> statement-breakpoint
ALTER TABLE `reconciliation_jobs` ADD `moduleType` enum('transaction_integrity','settlement','account_level') DEFAULT 'transaction_integrity' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_module_config_org` ON `module_configurations` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_module_config_type` ON `module_configurations` (`moduleType`);--> statement-breakpoint
CREATE INDEX `idx_jobs_module` ON `reconciliation_jobs` (`moduleType`);