CREATE TABLE `exception_workflow_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`workflowId` int NOT NULL,
	`exceptionId` int NOT NULL,
	`eventType` enum('started','reassigned','escalated','decision_recorded','decision_approved','closed') NOT NULL,
	`actorUserId` int NOT NULL,
	`note` text,
	`decisionEvidenceReference` varchar(500),
	`ownerUserId` int,
	`dueAt` timestamp,
	`outcome` enum('resolved','dismissed'),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `exception_workflow_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_exception_workflow_events_workflow` ON `exception_workflow_events` (`organizationId`,`workflowId`,`id`);