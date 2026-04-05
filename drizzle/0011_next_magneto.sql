CREATE TABLE `distributors` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`canonicalId` varchar(32) NOT NULL,
	`canonicalName` varchar(255) NOT NULL,
	`registeredBusinessName` varchar(255),
	`taxId` varchar(64),
	`primaryBankAccount` varchar(64),
	`primaryBankName` varchar(128),
	`contactEmail` varchar(255),
	`contactPhone` varchar(32),
	`zone` varchar(128),
	`status` enum('active','inactive','pending_confirmation','flagged') NOT NULL DEFAULT 'active',
	`nameVariants` json,
	`totalPaymentsMatched` int NOT NULL DEFAULT 0,
	`totalAmountMatched` decimal(18,2) NOT NULL DEFAULT '0',
	`lastPaymentAt` timestamp,
	`confirmedBy` int,
	`confirmedAt` timestamp,
	`notes` text,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `distributors_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_canonical_id_org` UNIQUE(`organizationId`,`canonicalId`)
);
--> statement-breakpoint
CREATE INDEX `idx_distributors_org` ON `distributors` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_distributors_status` ON `distributors` (`status`);