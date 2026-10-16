CREATE TABLE `shopify_shop_redaction_receipts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` varchar(36) NOT NULL,
	`requestHash` varchar(64) NOT NULL,
	`manifestVersion` int NOT NULL,
	`manifestSummary` json NOT NULL,
	`completedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `shopify_shop_redaction_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shopify_redaction_receipt_run` UNIQUE(`runId`),
	CONSTRAINT `uq_shopify_redaction_receipt_request` UNIQUE(`requestHash`)
);
--> statement-breakpoint
CREATE INDEX `idx_shopify_redaction_receipt_completed` ON `shopify_shop_redaction_receipts` (`completedAt`);