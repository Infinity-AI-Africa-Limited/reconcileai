ALTER TABLE `exception_workflow_events` MODIFY COLUMN `eventType` enum('started','reassigned','escalated','due_date_elapsed','decision_recorded','decision_approved','closed') NOT NULL;--> statement-breakpoint
ALTER TABLE `exception_workflow_events` MODIFY COLUMN `actorUserId` int;--> statement-breakpoint
ALTER TABLE `exception_workflow_events` ADD `lateResolutionReason` text;--> statement-breakpoint
ALTER TABLE `exception_workflows` ADD `overdueAt` timestamp;--> statement-breakpoint
ALTER TABLE `exception_workflows` ADD `lateResolutionReason` text;--> statement-breakpoint
CREATE INDEX `idx_exception_workflows_due_monitor` ON `exception_workflows` (`overdueAt`,`dueAt`,`id`);