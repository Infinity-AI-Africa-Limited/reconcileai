CREATE TABLE `anomaly_scores` (
	`id` int AUTO_INCREMENT NOT NULL,
	`transactionId` int NOT NULL,
	`organizationId` int,
	`anomalyScore` decimal(5,4) NOT NULL,
	`detectionMethod` enum('statistical_zscore','statistical_iqr','pattern_time','pattern_frequency','pattern_counterparty','llm_semantic','ensemble') NOT NULL,
	`detectionReason` text,
	`detectionMetadata` json,
	`isFlagged` boolean NOT NULL DEFAULT true,
	`reviewStatus` enum('pending','false_positive','confirmed','escalated','resolved') NOT NULL DEFAULT 'pending',
	`reviewedBy` int,
	`reviewedAt` timestamp,
	`reviewNotes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `anomaly_scores_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `detection_rules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`ruleName` varchar(255) NOT NULL,
	`ruleType` enum('amount_outlier','time_pattern','frequency_spike','counterparty_anomaly','description_suspicious','velocity_check','round_amount') NOT NULL,
	`threshold` decimal(10,4) NOT NULL,
	`isEnabled` boolean NOT NULL DEFAULT true,
	`severity` enum('low','medium','high','critical') NOT NULL DEFAULT 'medium',
	`ruleConfig` json,
	`description` text,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `detection_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_anomaly_txn` ON `anomaly_scores` (`transactionId`);--> statement-breakpoint
CREATE INDEX `idx_anomaly_org` ON `anomaly_scores` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_anomaly_score` ON `anomaly_scores` (`anomalyScore`);--> statement-breakpoint
CREATE INDEX `idx_anomaly_flagged` ON `anomaly_scores` (`isFlagged`);--> statement-breakpoint
CREATE INDEX `idx_anomaly_review` ON `anomaly_scores` (`reviewStatus`);--> statement-breakpoint
CREATE INDEX `idx_anomaly_method` ON `anomaly_scores` (`detectionMethod`);--> statement-breakpoint
CREATE INDEX `idx_rules_org` ON `detection_rules` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_rules_type` ON `detection_rules` (`ruleType`);--> statement-breakpoint
CREATE INDEX `idx_rules_enabled` ON `detection_rules` (`isEnabled`);