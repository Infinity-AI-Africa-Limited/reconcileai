ALTER TABLE `reconciliation_jobs` ADD `excludedCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reconciliation_jobs` ADD `excludedItems` json;