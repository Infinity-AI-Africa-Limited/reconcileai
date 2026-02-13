CREATE TABLE `audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int,
	`action` varchar(100) NOT NULL,
	`entityType` varchar(50) NOT NULL,
	`entityId` int,
	`details` json,
	`ipAddress` varchar(45),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`code` varchar(50) NOT NULL,
	`description` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `channels_id` PRIMARY KEY(`id`),
	CONSTRAINT `channels_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `exceptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`transactionId` int NOT NULL,
	`category` enum('missing_counterparty','amount_mismatch','timing_difference','duplicate_transaction','unmatched') NOT NULL,
	`severity` enum('low','medium','high','critical') NOT NULL DEFAULT 'medium',
	`description` text,
	`suggestedResolution` text,
	`aiAnalysis` text,
	`status` enum('open','in_review','resolved','dismissed') NOT NULL DEFAULT 'open',
	`assignedTo` int,
	`resolvedBy` int,
	`resolvedAt` timestamp,
	`resolutionNotes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `exceptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`sourceTransactionId` int NOT NULL,
	`targetTransactionId` int NOT NULL,
	`matchType` enum('exact','fuzzy','amount_tolerance','date_window','ai_suggested','manual') NOT NULL,
	`confidenceScore` decimal(5,2) NOT NULL,
	`amountDifference` decimal(18,2),
	`dateDifference` int,
	`matchReason` text,
	`status` enum('confirmed','pending_review','rejected') NOT NULL DEFAULT 'confirmed',
	`reviewedBy` int,
	`reviewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `matches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reconciliation_jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`sourceChannelId` int NOT NULL,
	`targetChannelId` int NOT NULL,
	`dateFrom` timestamp NOT NULL,
	`dateTo` timestamp NOT NULL,
	`amountTolerance` decimal(5,4) NOT NULL DEFAULT '0.005',
	`dateWindowDays` int NOT NULL DEFAULT 3,
	`status` enum('pending','running','completed','failed') NOT NULL DEFAULT 'pending',
	`totalSourceTxns` int NOT NULL DEFAULT 0,
	`totalTargetTxns` int NOT NULL DEFAULT 0,
	`matchedCount` int NOT NULL DEFAULT 0,
	`exceptionCount` int NOT NULL DEFAULT 0,
	`unmatchedCount` int NOT NULL DEFAULT 0,
	`matchRate` decimal(5,2),
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reconciliation_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reconciliation_reports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`userId` int NOT NULL,
	`reportType` enum('daily','weekly','monthly','custom') NOT NULL,
	`title` varchar(255) NOT NULL,
	`summary` json,
	`fileUrl` text,
	`format` enum('pdf','excel') NOT NULL DEFAULT 'pdf',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reconciliation_reports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`batchId` int NOT NULL,
	`channelId` int NOT NULL,
	`userId` int NOT NULL,
	`transactionRef` varchar(255),
	`externalRef` varchar(255),
	`description` text,
	`amount` decimal(18,2) NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'NGN',
	`transactionDate` timestamp NOT NULL,
	`valueDate` timestamp,
	`debitCredit` enum('debit','credit') NOT NULL,
	`counterparty` varchar(255),
	`status` enum('unmatched','matched','exception','manually_matched') NOT NULL DEFAULT 'unmatched',
	`matchId` int,
	`rawData` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `upload_batches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`channelId` int NOT NULL,
	`fileName` varchar(500) NOT NULL,
	`fileUrl` text,
	`totalRows` int NOT NULL DEFAULT 0,
	`validRows` int NOT NULL DEFAULT 0,
	`invalidRows` int NOT NULL DEFAULT 0,
	`status` enum('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `upload_batches_id` PRIMARY KEY(`id`)
);
