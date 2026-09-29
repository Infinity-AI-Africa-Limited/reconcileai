CREATE TABLE `shopify_order_redaction_tombstones` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`storeId` int NOT NULL,
	`keyVersion` varchar(32) NOT NULL,
	`orderDigest` varchar(64) NOT NULL,
	`sourceRequestId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `shopify_order_redaction_tombstones_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shopify_order_redaction_digest` UNIQUE(`organizationId`,`storeId`,`keyVersion`,`orderDigest`)
);
--> statement-breakpoint
CREATE TABLE `shopify_privacy_customer_redaction_jobs` (
	`requestId` int NOT NULL,
	`organizationId` int NOT NULL,
	`storeId` int NOT NULL,
	`status` enum('received','processing','manual_review','blocked_dependency','failed_retryable','failed_terminal','completed') NOT NULL DEFAULT 'received',
	`attempts` int NOT NULL DEFAULT 0,
	`leaseId` varchar(36),
	`leaseExpiresAt` timestamp,
	`nextAttemptAt` timestamp,
	`lastCheckpoint` varchar(80),
	`failureCode` varchar(80),
	`manifestVersion` int NOT NULL DEFAULT 1,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`recordsFound` int NOT NULL DEFAULT 0,
	`tombstonesWritten` int NOT NULL DEFAULT 0,
	`transactionsDeleted` int NOT NULL DEFAULT 0,
	`anomalyScoresDeleted` int NOT NULL DEFAULT 0,
	`orphanBatchesDeleted` int NOT NULL DEFAULT 0,
	`remainingTransactions` int NOT NULL DEFAULT 0,
	`selectorDestroyedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shopify_privacy_customer_redaction_jobs_requestId` PRIMARY KEY(`requestId`)
);
--> statement-breakpoint
ALTER TABLE `shopify_privacy_queue_outbox` MODIFY COLUMN `kind` enum('customer_request','customer_redact') NOT NULL;--> statement-breakpoint
ALTER TABLE `shopify_connector_stores` ADD `privacyRedactionState` enum('active','customer_redacting') DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `shopify_connector_stores` ADD `privacyRedactionRequestId` int;--> statement-breakpoint
CREATE INDEX `idx_shopify_order_redaction_store_version` ON `shopify_order_redaction_tombstones` (`organizationId`,`storeId`,`keyVersion`);--> statement-breakpoint
CREATE INDEX `idx_shopify_order_redaction_request` ON `shopify_order_redaction_tombstones` (`organizationId`,`sourceRequestId`);--> statement-breakpoint
CREATE INDEX `idx_shopify_privacy_redact_job_org_status` ON `shopify_privacy_customer_redaction_jobs` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_shopify_privacy_redact_job_store_status` ON `shopify_privacy_customer_redaction_jobs` (`storeId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_shopify_privacy_redact_job_claim` ON `shopify_privacy_customer_redaction_jobs` (`status`,`nextAttemptAt`,`leaseExpiresAt`);