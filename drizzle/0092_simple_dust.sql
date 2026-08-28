CREATE TABLE `reviewer_access_links` (
	`id` int AUTO_INCREMENT NOT NULL,
	`token` varchar(64) NOT NULL,
	`label` varchar(120) NOT NULL,
	`organizationId` int NOT NULL,
	`userId` int NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`lastUsedAt` timestamp,
	`useCount` int NOT NULL DEFAULT 0,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reviewer_access_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_reviewer_access_token` UNIQUE(`token`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `isReadOnly` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_reviewer_access_org` ON `reviewer_access_links` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_reviewer_access_expires` ON `reviewer_access_links` (`expiresAt`);