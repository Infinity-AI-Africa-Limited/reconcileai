CREATE TABLE `mm_exceptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` int NOT NULL,
	`pocKey` varchar(64) NOT NULL,
	`operator` enum('nip','opay','palmpay') NOT NULL,
	`category` varchar(64) NOT NULL,
	`side` varchar(16),
	`amount` decimal(30,2) NOT NULL DEFAULT '0',
	`txnDate` varchar(32),
	`reference` varchar(255),
	`sessionId` varchar(128),
	`nipSessionId` varchar(128),
	`description` varchar(500),
	`reversalStatus` varchar(32),
	`agentExplanation` text,
	`recommendedAction` text,
	`cbnRuleReference` varchar(255),
	`priorityLevel` varchar(10),
	`agentConfidence` int,
	`reviewStatus` varchar(16) NOT NULL DEFAULT 'OPEN',
	`reviewedBy` varchar(100),
	`reviewNote` text,
	`reviewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mm_exceptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mm_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pocKey` varchar(64) NOT NULL,
	`operator` enum('nip','opay','palmpay') NOT NULL,
	`settlementDate` varchar(32),
	`periodLabel` varchar(64),
	`settlementCount` int NOT NULL DEFAULT 0,
	`ledgerCount` int NOT NULL DEFAULT 0,
	`settlementTotal` decimal(30,2) NOT NULL DEFAULT '0',
	`ledgerTotal` decimal(30,2) NOT NULL DEFAULT '0',
	`varianceAmount` decimal(30,2) NOT NULL DEFAULT '0',
	`currencyCode` varchar(3) NOT NULL DEFAULT 'NGN',
	`matchedCount` int NOT NULL DEFAULT 0,
	`exceptionCount` int NOT NULL DEFAULT 0,
	`matchRate` decimal(5,2),
	`status` varchar(24) NOT NULL DEFAULT 'BALANCED',
	`aiSummary` text,
	`summary` json,
	`settlementFileName` varchar(500),
	`ledgerFileName` varchar(500),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mm_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_mm_exc_run` ON `mm_exceptions` (`runId`);--> statement-breakpoint
CREATE INDEX `idx_mm_exc_poc` ON `mm_exceptions` (`pocKey`);--> statement-breakpoint
CREATE INDEX `idx_mm_exc_category` ON `mm_exceptions` (`category`);--> statement-breakpoint
CREATE INDEX `idx_mm_exc_operator` ON `mm_exceptions` (`operator`);--> statement-breakpoint
CREATE INDEX `idx_mm_exc_status` ON `mm_exceptions` (`reviewStatus`);--> statement-breakpoint
CREATE INDEX `idx_mm_runs_poc` ON `mm_runs` (`pocKey`);--> statement-breakpoint
CREATE INDEX `idx_mm_runs_operator` ON `mm_runs` (`operator`);--> statement-breakpoint
CREATE INDEX `idx_mm_runs_created` ON `mm_runs` (`createdAt`);