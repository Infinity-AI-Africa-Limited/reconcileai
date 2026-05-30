CREATE TABLE `module_overrides` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`moduleType` enum('settlement','account_level') NOT NULL,
	`isEnabled` boolean NOT NULL,
	`reason` varchar(500),
	`setByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `module_overrides_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_org_module_override` UNIQUE(`organizationId`,`moduleType`)
);
--> statement-breakpoint
ALTER TABLE `module_configurations` MODIFY COLUMN `moduleType` enum('settlement','account_level') NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_module_override_org` ON `module_overrides` (`organizationId`);