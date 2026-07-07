CREATE TABLE `webhook_deliveries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`webhookId` int NOT NULL,
	`event` varchar(64) NOT NULL,
	`url` text NOT NULL,
	`status` enum('pending','delivered','failed') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`maxAttempts` int NOT NULL DEFAULT 6,
	`responseStatus` int,
	`lastError` varchar(500),
	`payloadSummary` varchar(500),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastAttemptAt` timestamp,
	`deliveredAt` timestamp,
	CONSTRAINT `webhook_deliveries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_whd_webhook` ON `webhook_deliveries` (`webhookId`);--> statement-breakpoint
CREATE INDEX `idx_whd_status` ON `webhook_deliveries` (`status`);--> statement-breakpoint
CREATE INDEX `idx_whd_created` ON `webhook_deliveries` (`createdAt`);