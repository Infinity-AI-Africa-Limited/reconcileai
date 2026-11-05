CREATE TABLE `sl_connector_billing_charges` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`slStoreId` int NOT NULL,
	`bizOrderNo` varchar(128) NOT NULL,
	`failureCountedAt` timestamp,
	`succeededAt` timestamp,
	`cancelledAt` timestamp,
	`deliveries` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sl_connector_billing_charges_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_sl_billing_charge_store_order` UNIQUE(`slStoreId`,`bizOrderNo`)
);
--> statement-breakpoint
CREATE INDEX `idx_sl_billing_charge_org` ON `sl_connector_billing_charges` (`organizationId`);