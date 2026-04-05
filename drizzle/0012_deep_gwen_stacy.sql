CREATE TABLE `agent_action_drafts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`exceptionId` int,
	`transactionRef` varchar(128),
	`actionType` enum('vendor_email','credit_note_request','journal_entry','payment_allocation','escalate_to_manager','no_action') NOT NULL,
	`subject` varchar(512) NOT NULL,
	`body` text NOT NULL,
	`metadata` json,
	`status` enum('pending_approval','approved','rejected','executed','modified') NOT NULL DEFAULT 'pending_approval',
	`diagnosisCategory` varchar(64),
	`diagnosisConfidence` int,
	`shortfallAmount` decimal(18,2),
	`currency` varchar(8) NOT NULL DEFAULT 'NGN',
	`createdByAgent` tinyint NOT NULL DEFAULT 1,
	`approvedBy` int,
	`approvedAt` timestamp,
	`rejectedBy` int,
	`rejectedAt` timestamp,
	`rejectionReason` text,
	`executedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_action_drafts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_memory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`exceptionId` int,
	`exceptionCategory` varchar(64) NOT NULL,
	`transactionRef` varchar(128),
	`amountRange` enum('0-100k','100k-1m','1m+') NOT NULL,
	`counterpartyType` varchar(64) NOT NULL DEFAULT 'distributor',
	`deductionType` varchar(64),
	`resolution` text NOT NULL,
	`outcome` enum('resolved','escalated','rejected') NOT NULL DEFAULT 'resolved',
	`reasoning` text NOT NULL,
	`embeddingText` text NOT NULL,
	`resolvedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_memory_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_action_drafts_org` ON `agent_action_drafts` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_action_drafts_status` ON `agent_action_drafts` (`status`);--> statement-breakpoint
CREATE INDEX `idx_action_drafts_exception` ON `agent_action_drafts` (`exceptionId`);--> statement-breakpoint
CREATE INDEX `idx_agent_memory_org` ON `agent_memory` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_agent_memory_category` ON `agent_memory` (`exceptionCategory`);