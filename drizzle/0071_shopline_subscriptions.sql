CREATE TABLE `sl_connector_subscriptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`slStoreId` int NOT NULL,
	`shoplineSubscriptionId` varchar(128),
	`planId` varchar(32) NOT NULL,
	`status` enum('trialing','active','past_due','cancelled','expired') NOT NULL DEFAULT 'trialing',
	`trialStartedAt` timestamp,
	`trialEndsAt` timestamp,
	`activatedAt` timestamp,
	`currentPeriodStart` timestamp,
	`currentPeriodEnd` timestamp,
	`cancelledAt` timestamp,
	`failedBillingAttempts` int NOT NULL DEFAULT 0,
	`lastFailureReason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sl_connector_subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_sl_sub_store` UNIQUE(`slStoreId`)
);
--> statement-breakpoint
CREATE INDEX `idx_sl_sub_org_status` ON `sl_connector_subscriptions` (`organizationId`,`status`);