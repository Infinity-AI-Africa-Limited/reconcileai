CREATE TABLE `exception_aging_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`slaDays` int NOT NULL DEFAULT 7,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `exception_aging_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `exception_aging_settings_organizationId_unique` UNIQUE(`organizationId`)
);
--> statement-breakpoint
CREATE INDEX `idx_aging_settings_org` ON `exception_aging_settings` (`organizationId`);