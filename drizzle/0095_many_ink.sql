CREATE TABLE `shopify_connector_stores` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`shopDomain` varchar(253) NOT NULL,
	`shopId` varchar(64) NOT NULL,
	`displayName` varchar(255) NOT NULL,
	`primaryDomain` varchar(253),
	`currency` varchar(8),
	`ianaTimezone` varchar(64),
	`grantedScopes` text NOT NULL,
	`requestedScopes` text NOT NULL,
	`apiVersion` varchar(16) NOT NULL DEFAULT '2026-07',
	`status` enum('pending_claim','active','reauthorization_required','uninstalled') NOT NULL DEFAULT 'pending_claim',
	`statusReason` varchar(64),
	`claimedByUserId` int,
	`claimedAt` timestamp,
	`lastWebhookAt` timestamp,
	`uninstalledAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shopify_connector_stores_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shopify_store_domain` UNIQUE(`shopDomain`),
	CONSTRAINT `uq_shopify_store_shop_id` UNIQUE(`shopId`)
);
--> statement-breakpoint
CREATE TABLE `shopify_connector_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`storeId` int NOT NULL,
	`organizationId` int NOT NULL,
	`accessTokenEnc` text NOT NULL,
	`refreshTokenEnc` text NOT NULL,
	`accessExpiresAt` timestamp NOT NULL,
	`refreshExpiresAt` timestamp,
	`refreshLeaseId` varchar(64),
	`refreshLeaseExpiresAt` timestamp,
	`rotationVersion` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shopify_connector_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shopify_token_store` UNIQUE(`storeId`)
);
--> statement-breakpoint
CREATE TABLE `shopify_oauth_states` (
	`id` int AUTO_INCREMENT NOT NULL,
	`shopDomain` varchar(253) NOT NULL,
	`stateHash` varchar(64) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`consumedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `shopify_oauth_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shopify_oauth_state_hash` UNIQUE(`stateHash`)
);
--> statement-breakpoint
CREATE TABLE `shopify_privacy_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`storeId` int,
	`organizationId` int,
	`topic` enum('customers/data_request','customers/redact','shop/redact') NOT NULL,
	`requestHash` varchar(64) NOT NULL,
	`subjectHash` varchar(64),
	`status` enum('received','completed','blocked_legal_retention','failed') NOT NULL DEFAULT 'received',
	`recordsAffected` int NOT NULL DEFAULT 0,
	`completionNote` text,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `shopify_privacy_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shopify_privacy_request` UNIQUE(`topic`,`requestHash`)
);
--> statement-breakpoint
CREATE TABLE `shopify_sync_cursors` (
	`id` int AUTO_INCREMENT NOT NULL,
	`storeId` int NOT NULL,
	`organizationId` int NOT NULL,
	`resource` enum('orders') NOT NULL DEFAULT 'orders',
	`cursor` varchar(512),
	`watermarkUpdatedAt` timestamp,
	`lastSuccessfulAt` timestamp,
	`lastErrorCode` varchar(80),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shopify_sync_cursors_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shopify_sync_cursor` UNIQUE(`storeId`,`resource`)
);
--> statement-breakpoint
CREATE TABLE `shopify_webhook_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`storeId` int,
	`organizationId` int,
	`webhookId` varchar(128) NOT NULL,
	`topic` varchar(100) NOT NULL,
	`payloadSha256` varchar(64) NOT NULL,
	`apiVersion` varchar(16),
	`status` enum('received','processed','failed','ignored') NOT NULL DEFAULT 'received',
	`errorCode` varchar(80),
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`processedAt` timestamp,
	CONSTRAINT `shopify_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shopify_webhook_id` UNIQUE(`webhookId`)
);
--> statement-breakpoint
CREATE INDEX `idx_shopify_store_org_status` ON `shopify_connector_stores` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_shopify_token_org_expiry` ON `shopify_connector_tokens` (`organizationId`,`accessExpiresAt`);--> statement-breakpoint
CREATE INDEX `idx_shopify_oauth_state_expiry` ON `shopify_oauth_states` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `idx_shopify_privacy_org_status` ON `shopify_privacy_requests` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_shopify_privacy_store_topic` ON `shopify_privacy_requests` (`storeId`,`topic`);--> statement-breakpoint
CREATE INDEX `idx_shopify_sync_org` ON `shopify_sync_cursors` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_shopify_webhook_store_status` ON `shopify_webhook_events` (`storeId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_shopify_webhook_org_received` ON `shopify_webhook_events` (`organizationId`,`receivedAt`);