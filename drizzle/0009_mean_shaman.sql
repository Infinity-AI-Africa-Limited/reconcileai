CREATE TABLE `resolution_templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`category` enum('unmatched','missing_counterparty','amount_mismatch','timing_difference','duplicate_transaction','reversal_unmatched','currency_mismatch','format_error') NOT NULL,
	`templateText` text NOT NULL,
	`isDefault` boolean NOT NULL DEFAULT false,
	`createdBy` int NOT NULL,
	`organizationId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `resolution_templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_resolution_templates_category` ON `resolution_templates` (`category`);--> statement-breakpoint
CREATE INDEX `idx_resolution_templates_org` ON `resolution_templates` (`organizationId`);