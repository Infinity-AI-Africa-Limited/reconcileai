CREATE TABLE `shopify_shop_redaction_jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` varchar(36) NOT NULL,
	`organizationId` int NOT NULL,
	`storeId` int NOT NULL,
	`requestHash` varchar(64) NOT NULL,
	`webhookId` varchar(128) NOT NULL,
	`status` enum('admitted','redacting','failed','completed') NOT NULL DEFAULT 'admitted',
	`attempts` int NOT NULL DEFAULT 0,
	`lastCheckpoint` varchar(80),
	`failureCode` varchar(80),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shopify_shop_redaction_jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shopify_redaction_request` UNIQUE(`requestHash`),
	CONSTRAINT `uq_shopify_redaction_run` UNIQUE(`runId`),
	CONSTRAINT `uq_shopify_redaction_store` UNIQUE(`storeId`)
);
--> statement-breakpoint
ALTER TABLE `shopify_connector_stores` MODIFY COLUMN `status` enum('pending_claim','active','reauthorization_required','uninstalled','redacting') NOT NULL DEFAULT 'pending_claim';--> statement-breakpoint
ALTER TABLE `organizations` ADD `deletionState` enum('active','redacting') DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `redactingAt` timestamp;--> statement-breakpoint
ALTER TABLE `organizations` ADD `redactionRunId` varchar(36);--> statement-breakpoint
CREATE INDEX `idx_shopify_redaction_org_status` ON `shopify_shop_redaction_jobs` (`organizationId`,`status`);