CREATE TABLE `sharedReportTokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`reportId` int NOT NULL,
	`token` varchar(128) NOT NULL,
	`createdByUserId` int NOT NULL,
	`organizationId` int,
	`recipientEmail` varchar(255),
	`recipientName` varchar(255),
	`note` text,
	`expiresAt` timestamp,
	`revokedAt` timestamp,
	`viewCount` int NOT NULL DEFAULT 0,
	`lastViewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sharedReportTokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `sharedReportTokens_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE INDEX `idx_shared_report_token` ON `sharedReportTokens` (`token`);--> statement-breakpoint
CREATE INDEX `idx_shared_report_reportId` ON `sharedReportTokens` (`reportId`);--> statement-breakpoint
CREATE INDEX `idx_shared_report_org` ON `sharedReportTokens` (`organizationId`);