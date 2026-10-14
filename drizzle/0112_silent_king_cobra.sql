CREATE TABLE `exception_workflows` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`exceptionId` int NOT NULL,
	`attemptNumber` int NOT NULL,
	`ownerUserId` int NOT NULL,
	`dueAt` timestamp NOT NULL,
	`approvalRequired` boolean NOT NULL DEFAULT false,
	`status` enum('active','escalated','decision_recorded','decision_submitted','approved','closed') NOT NULL DEFAULT 'active',
	`decisionRationale` text,
	`decisionEvidenceReference` varchar(500),
	`decisionSubmittedByUserId` int,
	`decisionSubmittedAt` timestamp,
	`escalationNote` text,
	`escalatedAt` timestamp,
	`escalatedByUserId` int,
	`approvedByUserId` int,
	`approvedAt` timestamp,
	`approvalNote` text,
	`closedByUserId` int,
	`closedAt` timestamp,
	`finalOutcome` enum('resolved','dismissed'),
	`startedByUserId` int NOT NULL,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `exception_workflows_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_exception_workflows_org_exception_attempt` UNIQUE(`organizationId`,`exceptionId`,`attemptNumber`)
);
--> statement-breakpoint
CREATE INDEX `idx_exception_workflows_org_status_due` ON `exception_workflows` (`organizationId`,`status`,`dueAt`);--> statement-breakpoint
CREATE INDEX `idx_exception_workflows_owner` ON `exception_workflows` (`organizationId`,`ownerUserId`,`status`);