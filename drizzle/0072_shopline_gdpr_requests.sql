CREATE TABLE `sl_connector_gdpr_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`slStoreId` int,
	`topic` varchar(64) NOT NULL,
	`shopDomain` varchar(255),
	`subjectHash` varchar(64),
	`status` enum('received','completed','failed','unresolved_store') NOT NULL DEFAULT 'received',
	`recordsAffected` int NOT NULL DEFAULT 0,
	`note` text,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `sl_connector_gdpr_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_sl_gdpr_org` ON `sl_connector_gdpr_requests` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_sl_gdpr_topic` ON `sl_connector_gdpr_requests` (`topic`);--> statement-breakpoint
CREATE INDEX `idx_sl_gdpr_shop` ON `sl_connector_gdpr_requests` (`shopDomain`);