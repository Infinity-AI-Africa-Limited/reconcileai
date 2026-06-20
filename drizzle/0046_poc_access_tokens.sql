CREATE TABLE `poc_access_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pocKey` varchar(64) NOT NULL,
	`token` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `poc_access_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `poc_access_tokens_pocKey_unique` UNIQUE(`pocKey`)
);
--> statement-breakpoint
CREATE INDEX `idx_poc_access_key` ON `poc_access_tokens` (`pocKey`);