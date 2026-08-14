CREATE TABLE `email_ingestion_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`emailSourceId` int,
	`organizationId` int,
	`channelId` int,
	`providerMessageId` varchar(255),
	`fromAddress` varchar(320),
	`toAddress` varchar(320),
	`subject` varchar(500),
	`attachmentName` varchar(500),
	`fileSize` int,
	`fileHash` varchar(64),
	`totalRows` int,
	`validRows` int,
	`invalidRows` int,
	`status` enum('success','partial','failed','rejected','skipped') NOT NULL,
	`rejectionReason` varchar(64),
	`errorMessage` text,
	`uploadBatchId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_ingestion_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_ingestion_sources` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`addressToken` varchar(64) NOT NULL,
	`allowedSenders` text,
	`channelId` int NOT NULL,
	`maxAttachmentBytes` int NOT NULL DEFAULT 10485760,
	`isActive` boolean NOT NULL DEFAULT true,
	`lastReceivedAt` timestamp,
	`lastErrorAt` timestamp,
	`lastErrorMessage` text,
	`totalFilesProcessed` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `email_ingestion_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_email_src_token` UNIQUE(`addressToken`)
);
--> statement-breakpoint
CREATE INDEX `idx_email_log_src` ON `email_ingestion_logs` (`emailSourceId`);--> statement-breakpoint
CREATE INDEX `idx_email_log_org` ON `email_ingestion_logs` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_email_log_status` ON `email_ingestion_logs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_email_log_msg` ON `email_ingestion_logs` (`providerMessageId`);--> statement-breakpoint
CREATE INDEX `idx_email_log_created` ON `email_ingestion_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_email_src_org` ON `email_ingestion_sources` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_email_src_active` ON `email_ingestion_sources` (`isActive`);