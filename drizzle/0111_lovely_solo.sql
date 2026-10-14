CREATE TABLE `control_policies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`policyType` enum('mapping','reconciliation') NOT NULL,
	`policyKey` varchar(100) NOT NULL,
	`version` int NOT NULL,
	`displayName` varchar(255) NOT NULL,
	`description` text NOT NULL,
	`definition` json NOT NULL,
	`definitionDigest` varchar(64) NOT NULL,
	`status` enum('draft','approved','active','retired') NOT NULL DEFAULT 'draft',
	`approvalReference` varchar(255),
	`approvedByUserId` int,
	`approvedAt` timestamp,
	`effectiveAt` timestamp NOT NULL,
	`activeSlot` varchar(240),
	`retirementReference` varchar(255),
	`retiredByUserId` int,
	`retiredAt` timestamp,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `control_policies_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_control_policy_org_type_key_version` UNIQUE(`organizationId`,`policyType`,`policyKey`,`version`),
	CONSTRAINT `uq_control_policy_active_slot` UNIQUE(`activeSlot`)
);
--> statement-breakpoint
CREATE INDEX `idx_control_policy_org_status` ON `control_policies` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_control_policy_org_effective` ON `control_policies` (`organizationId`,`effectiveAt`,`id`);