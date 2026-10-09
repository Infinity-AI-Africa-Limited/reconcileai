CREATE TABLE `control_batch_manifests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`sourceContractId` int NOT NULL,
	`sourceContractVersion` int NOT NULL,
	`controlPeriod` varchar(64) NOT NULL,
	`deliveryIdentity` varchar(255) NOT NULL,
	`uploadBatchId` int,
	`receivedAt` timestamp NOT NULL,
	`mappingVersion` varchar(128) NOT NULL,
	`reconciliationPolicyVersion` varchar(128) NOT NULL,
	`schemaState` enum('accepted','rejected','unknown') NOT NULL,
	`duplicateDelivery` enum('none','deduplicated','rejected') NOT NULL,
	`invalidRowCount` int NOT NULL DEFAULT 0,
	`expectedRecordCount` int,
	`expectedMonetaryTotal` varchar(40),
	`expectedCurrency` varchar(3),
	`receivedRecordCount` int NOT NULL,
	`receivedMonetaryTotal` varchar(40) NOT NULL,
	`receivedCurrency` varchar(3) NOT NULL,
	`recordedByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `control_batch_manifests_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_control_batch_manifest_contract_period_delivery` UNIQUE(`sourceContractId`,`controlPeriod`,`deliveryIdentity`)
);
--> statement-breakpoint
CREATE TABLE `control_source_contracts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`sourceKey` varchar(100) NOT NULL,
	`version` int NOT NULL,
	`role` enum('settlement','internal_register','bank_or_gl') NOT NULL,
	`displayName` varchar(255) NOT NULL,
	`systemName` varchar(255) NOT NULL,
	`controlPurpose` text NOT NULL,
	`accountableOwner` varchar(255) NOT NULL,
	`escalationOwner` varchar(255) NOT NULL,
	`deliveryRoute` varchar(64) NOT NULL,
	`timeZone` varchar(64) NOT NULL,
	`cutoffMinutes` int NOT NULL,
	`schemaVersion` varchar(128) NOT NULL,
	`controlTotalRequired` boolean NOT NULL DEFAULT true,
	`expectedCurrency` varchar(3),
	`status` enum('draft','approved','tested','active','retired') NOT NULL DEFAULT 'draft',
	`approvalReference` varchar(255),
	`effectiveAt` timestamp NOT NULL,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `control_source_contracts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_control_source_contract_org_key_version` UNIQUE(`organizationId`,`sourceKey`,`version`)
);
--> statement-breakpoint
CREATE INDEX `idx_control_batch_manifest_org_period` ON `control_batch_manifests` (`organizationId`,`controlPeriod`);--> statement-breakpoint
CREATE INDEX `idx_control_batch_manifest_contract` ON `control_batch_manifests` (`sourceContractId`);--> statement-breakpoint
CREATE INDEX `idx_control_source_contract_org_status` ON `control_source_contracts` (`organizationId`,`status`);