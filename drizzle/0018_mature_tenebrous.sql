CREATE TABLE `dashboard_stats_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`totalTransactions` bigint NOT NULL DEFAULT 0,
	`matchedTransactions` bigint NOT NULL DEFAULT 0,
	`unmatchedTransactions` bigint NOT NULL DEFAULT 0,
	`exceptionTransactions` bigint NOT NULL DEFAULT 0,
	`totalJobs` int NOT NULL DEFAULT 0,
	`completedJobs` int NOT NULL DEFAULT 0,
	`runningJobs` int NOT NULL DEFAULT 0,
	`avgMatchRate` decimal(5,2) NOT NULL DEFAULT '0.00',
	`totalExceptions` int NOT NULL DEFAULT 0,
	`openExceptions` int NOT NULL DEFAULT 0,
	`inReviewExceptions` int NOT NULL DEFAULT 0,
	`resolvedExceptions` int NOT NULL DEFAULT 0,
	`lastUpdatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dashboard_stats_cache_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_stats_cache_org` ON `dashboard_stats_cache` (`organizationId`);