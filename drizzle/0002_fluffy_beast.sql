CREATE TABLE `api_keys` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`keyHash` varchar(64) NOT NULL,
	`keyPrefix` varchar(8) NOT NULL,
	`permissions` json NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`lastUsedAt` timestamp,
	`expiresAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_keys_keyHash_unique` UNIQUE(`keyHash`)
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`code` varchar(50) NOT NULL,
	`country` varchar(3) NOT NULL DEFAULT 'NGA',
	`baseCurrency` varchar(3) NOT NULL DEFAULT 'NGN',
	`settings` json,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `organizations_id` PRIMARY KEY(`id`),
	CONSTRAINT `organizations_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`url` text NOT NULL,
	`secret` varchar(255) NOT NULL,
	`events` json NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`lastTriggeredAt` timestamp,
	`failureCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `webhooks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `exceptions` MODIFY COLUMN `category` enum('missing_counterparty','amount_mismatch','timing_difference','duplicate_transaction','unmatched','reversal_unmatched','currency_mismatch','format_error') NOT NULL;--> statement-breakpoint
ALTER TABLE `exceptions` MODIFY COLUMN `status` enum('open','in_review','resolved','dismissed','escalated') NOT NULL DEFAULT 'open';--> statement-breakpoint
ALTER TABLE `matches` MODIFY COLUMN `matchType` enum('exact','fuzzy','amount_tolerance','date_window','ai_suggested','manual','reversal') NOT NULL;--> statement-breakpoint
ALTER TABLE `reconciliation_jobs` MODIFY COLUMN `status` enum('pending','running','completed','failed','cancelled') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `reconciliation_reports` MODIFY COLUMN `format` enum('pdf','excel','csv') NOT NULL DEFAULT 'pdf';--> statement-breakpoint
ALTER TABLE `transactions` MODIFY COLUMN `status` enum('unmatched','matched','exception','manually_matched','reversed') NOT NULL DEFAULT 'unmatched';--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `organizationId` int;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `userAgent` varchar(500);--> statement-breakpoint
ALTER TABLE `channels` ADD `organizationId` int;--> statement-breakpoint
ALTER TABLE `channels` ADD `channelType` enum('bank_core','nibss','pos','atm','mobile_money','bank_transfer','agent_banking','fintech_api','card_payments','rtgs','swift','mobile_banking','ussd','qr_payment') DEFAULT 'bank_transfer' NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `country` varchar(3) DEFAULT 'NGA' NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `defaultCurrency` varchar(3) DEFAULT 'NGN' NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `matchingConfig` json;--> statement-breakpoint
ALTER TABLE `channels` ADD `fileFormat` json;--> statement-breakpoint
ALTER TABLE `channels` ADD `updatedAt` timestamp DEFAULT (now()) NOT NULL ON UPDATE CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `reconciliation_jobs` ADD `organizationId` int;--> statement-breakpoint
ALTER TABLE `reconciliation_jobs` ADD `engineConfig` json;--> statement-breakpoint
ALTER TABLE `reconciliation_jobs` ADD `processingTimeMs` int;--> statement-breakpoint
ALTER TABLE `reconciliation_reports` ADD `organizationId` int;--> statement-breakpoint
ALTER TABLE `transactions` ADD `organizationId` int;--> statement-breakpoint
ALTER TABLE `transactions` ADD `isReversal` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `originalTransactionRef` varchar(255);--> statement-breakpoint
ALTER TABLE `upload_batches` ADD `organizationId` int;--> statement-breakpoint
ALTER TABLE `upload_batches` ADD `fileHash` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD `organizationId` int;--> statement-breakpoint
ALTER TABLE `users` ADD `isActive` boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_apikeys_org` ON `api_keys` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_apikeys_user` ON `api_keys` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_apikeys_hash` ON `api_keys` (`keyHash`);--> statement-breakpoint
CREATE INDEX `idx_apikeys_prefix` ON `api_keys` (`keyPrefix`);--> statement-breakpoint
CREATE INDEX `idx_webhooks_org` ON `webhooks` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_webhooks_user` ON `webhooks` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_webhooks_active` ON `webhooks` (`isActive`);--> statement-breakpoint
CREATE INDEX `idx_audit_user` ON `audit_logs` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_audit_org` ON `audit_logs` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_audit_entity` ON `audit_logs` (`entityType`,`entityId`);--> statement-breakpoint
CREATE INDEX `idx_audit_action` ON `audit_logs` (`action`);--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_channels_org` ON `channels` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_channels_type` ON `channels` (`channelType`);--> statement-breakpoint
CREATE INDEX `idx_exceptions_job` ON `exceptions` (`jobId`);--> statement-breakpoint
CREATE INDEX `idx_exceptions_txn` ON `exceptions` (`transactionId`);--> statement-breakpoint
CREATE INDEX `idx_exceptions_status` ON `exceptions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_exceptions_severity` ON `exceptions` (`severity`);--> statement-breakpoint
CREATE INDEX `idx_exceptions_category` ON `exceptions` (`category`);--> statement-breakpoint
CREATE INDEX `idx_exceptions_assigned` ON `exceptions` (`assignedTo`);--> statement-breakpoint
CREATE INDEX `idx_matches_job` ON `matches` (`jobId`);--> statement-breakpoint
CREATE INDEX `idx_matches_source` ON `matches` (`sourceTransactionId`);--> statement-breakpoint
CREATE INDEX `idx_matches_target` ON `matches` (`targetTransactionId`);--> statement-breakpoint
CREATE INDEX `idx_matches_status` ON `matches` (`status`);--> statement-breakpoint
CREATE INDEX `idx_matches_type` ON `matches` (`matchType`);--> statement-breakpoint
CREATE INDEX `idx_jobs_user` ON `reconciliation_jobs` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_jobs_org` ON `reconciliation_jobs` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_jobs_status` ON `reconciliation_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_jobs_source` ON `reconciliation_jobs` (`sourceChannelId`);--> statement-breakpoint
CREATE INDEX `idx_jobs_target` ON `reconciliation_jobs` (`targetChannelId`);--> statement-breakpoint
CREATE INDEX `idx_jobs_created` ON `reconciliation_jobs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_reports_job` ON `reconciliation_reports` (`jobId`);--> statement-breakpoint
CREATE INDEX `idx_reports_user` ON `reconciliation_reports` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_reports_org` ON `reconciliation_reports` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_txn_batch` ON `transactions` (`batchId`);--> statement-breakpoint
CREATE INDEX `idx_txn_channel` ON `transactions` (`channelId`);--> statement-breakpoint
CREATE INDEX `idx_txn_user` ON `transactions` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_txn_org` ON `transactions` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_txn_ref` ON `transactions` (`transactionRef`);--> statement-breakpoint
CREATE INDEX `idx_txn_ext_ref` ON `transactions` (`externalRef`);--> statement-breakpoint
CREATE INDEX `idx_txn_status` ON `transactions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_txn_match` ON `transactions` (`matchId`);--> statement-breakpoint
CREATE INDEX `idx_txn_channel_date_status` ON `transactions` (`channelId`,`transactionDate`,`status`);--> statement-breakpoint
CREATE INDEX `idx_txn_ref_channel` ON `transactions` (`transactionRef`,`channelId`);--> statement-breakpoint
CREATE INDEX `idx_txn_amount_date` ON `transactions` (`amount`,`transactionDate`);--> statement-breakpoint
CREATE INDEX `idx_batches_user` ON `upload_batches` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_batches_channel` ON `upload_batches` (`channelId`);--> statement-breakpoint
CREATE INDEX `idx_batches_org` ON `upload_batches` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_batches_hash` ON `upload_batches` (`fileHash`);--> statement-breakpoint
CREATE INDEX `idx_batches_status` ON `upload_batches` (`status`);--> statement-breakpoint
CREATE INDEX `idx_users_org` ON `users` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_users_email` ON `users` (`email`);