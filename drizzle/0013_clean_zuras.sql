CREATE TABLE `demo_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`companyName` varchar(256) NOT NULL,
	`contactEmail` varchar(256) NOT NULL,
	`monthlyPaymentVolume` varchar(64),
	`message` text,
	`source` varchar(64) DEFAULT 'corporate_b2b_landing',
	`status` enum('new','contacted','qualified','closed') NOT NULL DEFAULT 'new',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `demo_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `guest_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`token` varchar(64) NOT NULL,
	`createdBy` int NOT NULL,
	`organizationId` int,
	`label` varchar(128) DEFAULT 'Demo Link',
	`expiresAt` timestamp NOT NULL,
	`viewCount` int NOT NULL DEFAULT 0,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `guest_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `guest_tokens_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE INDEX `idx_demo_requests_status` ON `demo_requests` (`status`);--> statement-breakpoint
CREATE INDEX `idx_demo_requests_email` ON `demo_requests` (`contactEmail`);--> statement-breakpoint
CREATE INDEX `idx_guest_tokens_token` ON `guest_tokens` (`token`);--> statement-breakpoint
CREATE INDEX `idx_guest_tokens_created_by` ON `guest_tokens` (`createdBy`);