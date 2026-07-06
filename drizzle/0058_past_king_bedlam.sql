CREATE TABLE `tenant_encryption_keys` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`provider` enum('local','aws_kms') NOT NULL,
	`wrappedDek` text NOT NULL,
	`kmsKeyId` varchar(400),
	`version` int NOT NULL DEFAULT 1,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`rotatedAt` timestamp,
	CONSTRAINT `tenant_encryption_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tenant_key_org_version` UNIQUE(`organizationId`,`version`)
);
--> statement-breakpoint
CREATE TABLE `tenant_quotas` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`apiRequestsPerMin` int NOT NULL DEFAULT 300,
	`webhookEventsPerMin` int NOT NULL DEFAULT 1500,
	`maxConcurrentReconciliations` int NOT NULL DEFAULT 2,
	`maxCsvImportRowsPerDay` int NOT NULL DEFAULT 2000000,
	`dailyTransactionSoftLimit` int NOT NULL DEFAULT 1000000,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenant_quotas_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tenant_quota_org` UNIQUE(`organizationId`)
);
--> statement-breakpoint
CREATE INDEX `idx_tenant_key_org_active` ON `tenant_encryption_keys` (`organizationId`,`isActive`);