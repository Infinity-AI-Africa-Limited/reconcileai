ALTER TABLE `shopify_privacy_queue_outbox` MODIFY COLUMN `kind` enum('customer_request','customer_redact','shop_redact') NOT NULL;--> statement-breakpoint
ALTER TABLE `shopify_shop_redaction_jobs` MODIFY COLUMN `status` enum('admitted','processing','blocked_dependency','manual_review','failed_retryable','failed_terminal','completed','redacting','failed') NOT NULL DEFAULT 'admitted';--> statement-breakpoint
ALTER TABLE `shopify_shop_redaction_jobs` ADD `privacyRequestId` int;--> statement-breakpoint
ALTER TABLE `shopify_shop_redaction_jobs` ADD `leaseId` varchar(36);--> statement-breakpoint
ALTER TABLE `shopify_shop_redaction_jobs` ADD `leaseExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `shopify_shop_redaction_jobs` ADD `nextAttemptAt` timestamp;--> statement-breakpoint
ALTER TABLE `shopify_shop_redaction_jobs` ADD `manifestVersion` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `shopify_shop_redaction_jobs` ADD `manifestSummary` json;--> statement-breakpoint
ALTER TABLE `shopify_shop_redaction_jobs` ADD `startedAt` timestamp;--> statement-breakpoint
ALTER TABLE `shopify_shop_redaction_jobs` ADD `completedAt` timestamp;--> statement-breakpoint
ALTER TABLE `shopify_shop_redaction_jobs` ADD CONSTRAINT `uq_shopify_redaction_privacy_request` UNIQUE(`privacyRequestId`);--> statement-breakpoint
CREATE INDEX `idx_shopify_redaction_claim` ON `shopify_shop_redaction_jobs` (`status`,`nextAttemptAt`,`leaseExpiresAt`);