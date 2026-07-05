CREATE TABLE `wc_connector_configs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`name` varchar(255) NOT NULL DEFAULT 'WoodCore Core Banking',
	`baseUrl` varchar(500) NOT NULL,
	`tenantId` varchar(100) NOT NULL DEFAULT 'default',
	`authMode` enum('oauth2','api_key','basic') NOT NULL DEFAULT 'oauth2',
	`oauthClientId` varchar(255),
	`oauthClientSecretEnc` text,
	`oauthTokenUrl` varchar(500),
	`oauthScope` varchar(255),
	`apiKeyEnc` text,
	`apiKeyHeader` varchar(100) NOT NULL DEFAULT 'x-api-key',
	`basicUsername` varchar(255),
	`basicPasswordEnc` text,
	`webhookSecretEnc` text,
	`webhookEnabled` boolean NOT NULL DEFAULT true,
	`batchSyncEnabled` boolean NOT NULL DEFAULT true,
	`batchSyncHourUtc` int NOT NULL DEFAULT 2,
	`writeBackEnabled` boolean NOT NULL DEFAULT false,
	`pageSize` int NOT NULL DEFAULT 500,
	`maxRetries` int NOT NULL DEFAULT 3,
	`requestTimeoutMs` int NOT NULL DEFAULT 30000,
	`endpointsJson` json,
	`isEnabled` boolean NOT NULL DEFAULT false,
	`lastHealthStatus` enum('ok','degraded','down','unknown') NOT NULL DEFAULT 'unknown',
	`lastHealthCheckAt` timestamp,
	`lastHealthDetail` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `wc_connector_configs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_wc_conn_org` UNIQUE(`organizationId`)
);
--> statement-breakpoint
CREATE TABLE `wc_connector_dead_letters` (
	`id` int AUTO_INCREMENT NOT NULL,
	`configId` int NOT NULL,
	`organizationId` int NOT NULL,
	`source` enum('webhook','batch_sync','mapping','api_call','write_back') NOT NULL,
	`refType` varchar(100),
	`refId` varchar(191),
	`payload` json,
	`error` text NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`maxAttempts` int NOT NULL DEFAULT 5,
	`nextRetryAt` timestamp,
	`lastAttemptAt` timestamp,
	`status` enum('pending','retrying','resolved','exhausted','discarded') NOT NULL DEFAULT 'pending',
	`resolutionNote` text,
	`resolvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `wc_connector_dead_letters_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_connector_field_mappings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`configId` int NOT NULL,
	`organizationId` int NOT NULL,
	`entity` enum('savings_transaction','loan_transaction','journal_entry') NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`rulesJson` json NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`notes` text,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `wc_connector_field_mappings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_connector_sync_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`configId` int NOT NULL,
	`organizationId` int NOT NULL,
	`trigger` enum('scheduled','manual','webhook_gap','backfill') NOT NULL,
	`scope` enum('savings','loans','gl','all') NOT NULL DEFAULT 'all',
	`windowFrom` timestamp NOT NULL,
	`windowTo` timestamp NOT NULL,
	`status` enum('running','completed','partial','failed') NOT NULL DEFAULT 'running',
	`fetched` int NOT NULL DEFAULT 0,
	`inserted` int NOT NULL DEFAULT 0,
	`duplicates` int NOT NULL DEFAULT 0,
	`failed` int NOT NULL DEFAULT 0,
	`error` text,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`finishedAt` timestamp,
	`durationMs` int,
	CONSTRAINT `wc_connector_sync_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_connector_webhook_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`configId` int NOT NULL,
	`organizationId` int NOT NULL,
	`eventId` varchar(191) NOT NULL,
	`eventType` varchar(100),
	`entity` varchar(50),
	`payload` json,
	`signatureValid` boolean NOT NULL DEFAULT false,
	`status` enum('received','processed','failed','duplicate','quarantined') NOT NULL DEFAULT 'received',
	`error` text,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`processedAt` timestamp,
	CONSTRAINT `wc_connector_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_wc_webhook_event` UNIQUE(`configId`,`eventId`)
);
--> statement-breakpoint
CREATE INDEX `idx_wc_dlq_due` ON `wc_connector_dead_letters` (`status`,`nextRetryAt`);--> statement-breakpoint
CREATE INDEX `idx_wc_dlq_config` ON `wc_connector_dead_letters` (`configId`);--> statement-breakpoint
CREATE INDEX `idx_wc_dlq_created` ON `wc_connector_dead_letters` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_wc_map_config_entity` ON `wc_connector_field_mappings` (`configId`,`entity`);--> statement-breakpoint
CREATE INDEX `idx_wc_map_active` ON `wc_connector_field_mappings` (`isActive`);--> statement-breakpoint
CREATE INDEX `idx_wc_sync_config` ON `wc_connector_sync_runs` (`configId`);--> statement-breakpoint
CREATE INDEX `idx_wc_sync_status` ON `wc_connector_sync_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_wc_sync_started` ON `wc_connector_sync_runs` (`startedAt`);--> statement-breakpoint
CREATE INDEX `idx_wc_webhook_status` ON `wc_connector_webhook_events` (`status`);--> statement-breakpoint
CREATE INDEX `idx_wc_webhook_received` ON `wc_connector_webhook_events` (`receivedAt`);