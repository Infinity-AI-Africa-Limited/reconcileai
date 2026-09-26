CREATE TABLE `shopify_privacy_artifacts` (
	`requestId` int NOT NULL,
	`organizationId` int NOT NULL,
	`storeId` int NOT NULL,
	`publicId` varchar(36) NOT NULL,
	`schemaVersion` int NOT NULL DEFAULT 1,
	`artifactKind` enum('order_evidence','zero_record_attestation') NOT NULL,
	`objectKey` varchar(768) NOT NULL,
	`sha256` varchar(64),
	`sizeBytes` int,
	`recordsFound` int NOT NULL DEFAULT 0,
	`zeroReasonCode` varchar(80),
	`status` enum('writing','ready','deleted') NOT NULL DEFAULT 'writing',
	`recipientUserId` int NOT NULL,
	`deliveryChannel` enum('authenticated_portal') NOT NULL DEFAULT 'authenticated_portal',
	`deliveryStatus` enum('pending','acknowledged') NOT NULL DEFAULT 'pending',
	`deliveryAcceptedAt` timestamp,
	`generatedAt` timestamp NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`downloadedAt` timestamp,
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shopify_privacy_artifacts_requestId` PRIMARY KEY(`requestId`),
	CONSTRAINT `uq_shopify_privacy_artifact_public` UNIQUE(`publicId`)
);
--> statement-breakpoint
CREATE TABLE `shopify_privacy_data_request_jobs` (
	`requestId` int NOT NULL,
	`organizationId` int NOT NULL,
	`storeId` int NOT NULL,
	`status` enum('received','processing','awaiting_delivery','manual_review','blocked_dependency','blocked_legal_retention','failed_retryable','failed_terminal','completed') NOT NULL DEFAULT 'received',
	`attempts` int NOT NULL DEFAULT 0,
	`leaseId` varchar(36),
	`leaseExpiresAt` timestamp,
	`nextAttemptAt` timestamp,
	`lastCheckpoint` varchar(80),
	`failureCode` varchar(80),
	`manifestVersion` int NOT NULL DEFAULT 1,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`artifactId` int,
	`recordsFound` int NOT NULL DEFAULT 0,
	`recordsAffected` int NOT NULL DEFAULT 0,
	`selectorDestroyedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shopify_privacy_data_request_jobs_requestId` PRIMARY KEY(`requestId`)
);
--> statement-breakpoint
CREATE TABLE `shopify_privacy_queue_outbox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`kind` enum('customer_request') NOT NULL,
	`jobId` int NOT NULL,
	`status` enum('pending','dispatching','failed_retryable','failed_terminal','dispatched') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`leaseId` varchar(36),
	`leaseExpiresAt` timestamp,
	`nextAttemptAt` timestamp,
	`failureCode` varchar(80),
	`dispatchedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shopify_privacy_queue_outbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shopify_privacy_outbox_job` UNIQUE(`kind`,`jobId`)
);
--> statement-breakpoint
ALTER TABLE `shopify_privacy_requests` MODIFY COLUMN `status` enum('received','processing','awaiting_delivery','manual_review','blocked_dependency','blocked_legal_retention','failed_retryable','failed_terminal','completed','failed') NOT NULL DEFAULT 'received';--> statement-breakpoint
CREATE INDEX `idx_shopify_privacy_artifact_recipient` ON `shopify_privacy_artifacts` (`organizationId`,`recipientUserId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_shopify_privacy_artifact_expiry` ON `shopify_privacy_artifacts` (`status`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `idx_shopify_privacy_data_job_org_status` ON `shopify_privacy_data_request_jobs` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_shopify_privacy_data_job_claim` ON `shopify_privacy_data_request_jobs` (`status`,`nextAttemptAt`,`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `idx_shopify_privacy_outbox_dispatch` ON `shopify_privacy_queue_outbox` (`status`,`nextAttemptAt`,`leaseExpiresAt`);