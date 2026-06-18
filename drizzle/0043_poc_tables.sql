CREATE TABLE `poc_exceptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` int NOT NULL,
	`pocSlug` varchar(64) NOT NULL,
	`category` varchar(48) NOT NULL,
	`side` varchar(16),
	`amount` decimal(30,2) NOT NULL DEFAULT '0',
	`txnDate` varchar(32),
	`reference` varchar(255),
	`description` varchar(500),
	`agentExplanation` text,
	`recommendedAction` text,
	`priorityLevel` varchar(10),
	`agentConfidence` int,
	`reviewStatus` varchar(16) NOT NULL DEFAULT 'OPEN',
	`reviewedBy` varchar(100),
	`reviewNote` text,
	`reviewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `poc_exceptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `poc_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pocSlug` varchar(64) NOT NULL,
	`ledgerUploadId` int,
	`statementUploadId` int,
	`currencyCode` varchar(3) NOT NULL DEFAULT 'NGN',
	`ledgerCount` int NOT NULL DEFAULT 0,
	`statementCount` int NOT NULL DEFAULT 0,
	`ledgerTotal` decimal(30,2) NOT NULL DEFAULT '0',
	`statementTotal` decimal(30,2) NOT NULL DEFAULT '0',
	`varianceAmount` decimal(30,2) NOT NULL DEFAULT '0',
	`status` varchar(24) NOT NULL DEFAULT 'BALANCED',
	`matchedCount` int NOT NULL DEFAULT 0,
	`exceptionCount` int NOT NULL DEFAULT 0,
	`matchRate` decimal(5,2),
	`summary` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `poc_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `poc_share_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`token` varchar(64) NOT NULL,
	`runId` int NOT NULL,
	`pocSlug` varchar(64) NOT NULL,
	`createdBy` varchar(100),
	`expiresAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `poc_share_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `poc_share_tokens_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `poc_uploads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pocSlug` varchar(64) NOT NULL,
	`side` varchar(16) NOT NULL,
	`fileName` varchar(500),
	`fileType` varchar(16),
	`rowCount` int NOT NULL DEFAULT 0,
	`rows` json NOT NULL,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `poc_uploads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_poc_exceptions_run` ON `poc_exceptions` (`runId`);--> statement-breakpoint
CREATE INDEX `idx_poc_exceptions_slug` ON `poc_exceptions` (`pocSlug`);--> statement-breakpoint
CREATE INDEX `idx_poc_runs_slug` ON `poc_runs` (`pocSlug`);--> statement-breakpoint
CREATE INDEX `idx_poc_share_token` ON `poc_share_tokens` (`token`);--> statement-breakpoint
CREATE INDEX `idx_poc_uploads_slug` ON `poc_uploads` (`pocSlug`);