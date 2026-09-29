CREATE TABLE `shopify_privacy_request_selectors` (
	`id` int AUTO_INCREMENT NOT NULL,
	`requestId` int NOT NULL,
	`organizationId` int NOT NULL,
	`resourceType` enum('customer','order') NOT NULL,
	`position` int NOT NULL,
	`externalIdEnc` text NOT NULL,
	`externalIdHmac` varchar(80) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `shopify_privacy_request_selectors_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shopify_privacy_selector_position` UNIQUE(`requestId`,`resourceType`,`position`)
);
--> statement-breakpoint
ALTER TABLE `shopify_privacy_requests` MODIFY COLUMN `status` enum('received','manual_review','completed','blocked_legal_retention','failed') NOT NULL DEFAULT 'received';--> statement-breakpoint
ALTER TABLE `shopify_privacy_requests` ADD `admissionErrorCode` varchar(80);--> statement-breakpoint
CREATE INDEX `idx_shopify_privacy_selector_org_request` ON `shopify_privacy_request_selectors` (`organizationId`,`requestId`);--> statement-breakpoint
CREATE INDEX `idx_shopify_privacy_selector_lookup` ON `shopify_privacy_request_selectors` (`organizationId`,`resourceType`,`externalIdHmac`);