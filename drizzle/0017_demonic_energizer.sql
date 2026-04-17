CREATE TABLE `wc_share_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`token` varchar(64) NOT NULL,
	`reconciliation_run_id` int NOT NULL,
	`created_by` varchar(100),
	`expires_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `wc_share_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `wc_share_tokens_token_unique` UNIQUE(`token`),
	CONSTRAINT `idx_wc_share_token` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE INDEX `idx_wc_share_run` ON `wc_share_tokens` (`reconciliation_run_id`);