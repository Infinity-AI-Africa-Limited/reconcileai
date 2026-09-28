CREATE TABLE `shopify_sync_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`storeId` int NOT NULL,
	`organizationId` int NOT NULL,
	`status` enum('queued','succeeded','failed') NOT NULL DEFAULT 'queued',
	`errorCode` varchar(80),
	`requestedAt` timestamp NOT NULL,
	`answeredAt` timestamp,
	CONSTRAINT `shopify_sync_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `shopify_sync_cursors` ADD `lastErrorAt` timestamp;--> statement-breakpoint
ALTER TABLE `shopify_sync_cursors` ADD `syncRequestCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_shopify_sync_request_store` ON `shopify_sync_requests` (`storeId`,`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_shopify_sync_request_org` ON `shopify_sync_requests` (`organizationId`);