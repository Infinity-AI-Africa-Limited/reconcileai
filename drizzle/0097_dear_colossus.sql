ALTER TABLE `shopify_sync_cursors` ADD `lastErrorAt` timestamp;--> statement-breakpoint
ALTER TABLE `shopify_sync_cursors` ADD `syncRequestedAt` timestamp;--> statement-breakpoint
ALTER TABLE `shopify_sync_cursors` ADD `syncRequestSeq` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shopify_sync_cursors` ADD `syncAnsweredSeq` int DEFAULT 0 NOT NULL;