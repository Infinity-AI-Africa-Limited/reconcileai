CREATE TABLE `sl_connector_stores` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`storeHandle` varchar(128) NOT NULL,
	`storeId` varchar(64) NOT NULL,
	`merchantId` varchar(64),
	`domain` varchar(255),
	`currency` varchar(8),
	`ianaTimezone` varchar(64),
	`grantedScopes` text,
	`apiVersion` varchar(16) NOT NULL DEFAULT 'v20260601',
	`status` enum('active','suspended','uninstalled') NOT NULL DEFAULT 'active',
	`installedAt` timestamp NOT NULL DEFAULT (now()),
	`uninstalledAt` timestamp,
	`lastSyncAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sl_connector_stores_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_sl_store_org_handle` UNIQUE(`organizationId`,`storeHandle`)
);
--> statement-breakpoint
CREATE TABLE `sl_connector_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`slStoreId` int NOT NULL,
	`organizationId` int NOT NULL,
	`encryptedToken` text NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`refreshedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sl_connector_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_sl_token_store` UNIQUE(`slStoreId`)
);
--> statement-breakpoint
CREATE TABLE `sl_connector_webhook_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`slStoreId` int NOT NULL,
	`webhookId` varchar(64) NOT NULL,
	`topic` varchar(64) NOT NULL,
	`payloadJson` json,
	`status` enum('pending','processed','failed','dlq') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`errorMessage` text,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`processedAt` timestamp,
	CONSTRAINT `sl_connector_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_sl_webhook_id` UNIQUE(`webhookId`)
);
--> statement-breakpoint
CREATE INDEX `idx_sl_store_status` ON `sl_connector_stores` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sl_token_expires` ON `sl_connector_tokens` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `idx_sl_webhook_org_status` ON `sl_connector_webhook_events` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_sl_webhook_topic` ON `sl_connector_webhook_events` (`topic`);