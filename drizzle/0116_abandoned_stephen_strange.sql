CREATE TABLE `shopify_evidence_retention_receipts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`storeId` int NOT NULL,
	`retentionDays` int NOT NULL,
	`cutoffAt` timestamp NOT NULL,
	`summary` json NOT NULL,
	`completedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `shopify_evidence_retention_receipts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_shopify_retention_receipt_store_completed` ON `shopify_evidence_retention_receipts` (`organizationId`,`storeId`,`completedAt`);--> statement-breakpoint
CREATE INDEX `idx_shopify_retention_receipt_completed` ON `shopify_evidence_retention_receipts` (`completedAt`);