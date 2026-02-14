CREATE TABLE `email_preferences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`organizationId` int,
	`emailEnabled` boolean NOT NULL DEFAULT true,
	`defaultRecipients` json,
	`includeMatchBreakdown` boolean NOT NULL DEFAULT true,
	`includeExceptionDetails` boolean NOT NULL DEFAULT true,
	`includeChannelPerformance` boolean NOT NULL DEFAULT true,
	`includeTrendAnalysis` boolean NOT NULL DEFAULT false,
	`notifyOnCompletion` boolean NOT NULL DEFAULT true,
	`notifyOnFailure` boolean NOT NULL DEFAULT true,
	`notifyOnHighExceptions` boolean NOT NULL DEFAULT true,
	`highExceptionThreshold` int NOT NULL DEFAULT 10,
	`lowMatchRateThreshold` decimal(5,2) NOT NULL DEFAULT '80.00',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `email_preferences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `job_progress_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`phase` enum('queued','loading_data','pass1_exact_match','pass2_fuzzy_match','pass3_tolerance_match','duplicate_detection','reversal_detection','exception_categorization','ai_analysis','finalizing','completed','failed') NOT NULL,
	`progress` int NOT NULL DEFAULT 0,
	`message` text,
	`processedCount` int NOT NULL DEFAULT 0,
	`totalCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `job_progress_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `schedule_run_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`scheduledTaskId` int NOT NULL,
	`jobId` int,
	`status` enum('success','failed','skipped','running') NOT NULL,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	`matchedCount` int,
	`exceptionCount` int,
	`totalTransactions` int,
	`matchRate` decimal(5,2),
	`errorMessage` text,
	`emailSent` boolean NOT NULL DEFAULT false,
	`emailError` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `schedule_run_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`organizationId` int,
	`name` varchar(255) NOT NULL,
	`description` text,
	`sourceChannelId` int NOT NULL,
	`targetChannelId` int NOT NULL,
	`frequency` enum('daily','weekly','biweekly','monthly') NOT NULL,
	`scheduledTime` varchar(5) NOT NULL,
	`scheduledDayOfWeek` int,
	`scheduledDayOfMonth` int,
	`timezone` varchar(64) NOT NULL DEFAULT 'Africa/Lagos',
	`amountTolerance` decimal(5,4) NOT NULL DEFAULT '0.005',
	`dateWindowDays` int NOT NULL DEFAULT 3,
	`lookbackDays` int NOT NULL DEFAULT 1,
	`sendEmailReport` boolean NOT NULL DEFAULT true,
	`emailRecipients` json,
	`isActive` boolean NOT NULL DEFAULT true,
	`lastRunAt` timestamp,
	`lastRunJobId` int,
	`lastRunStatus` enum('success','failed','skipped'),
	`nextRunAt` timestamp,
	`totalRuns` int NOT NULL DEFAULT 0,
	`successfulRuns` int NOT NULL DEFAULT 0,
	`failedRuns` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `scheduled_tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_email_pref_user` ON `email_preferences` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_email_pref_org` ON `email_preferences` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_progress_job` ON `job_progress_events` (`jobId`);--> statement-breakpoint
CREATE INDEX `idx_progress_phase` ON `job_progress_events` (`phase`);--> statement-breakpoint
CREATE INDEX `idx_progress_created` ON `job_progress_events` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_run_hist_task` ON `schedule_run_history` (`scheduledTaskId`);--> statement-breakpoint
CREATE INDEX `idx_run_hist_job` ON `schedule_run_history` (`jobId`);--> statement-breakpoint
CREATE INDEX `idx_run_hist_status` ON `schedule_run_history` (`status`);--> statement-breakpoint
CREATE INDEX `idx_run_hist_started` ON `schedule_run_history` (`startedAt`);--> statement-breakpoint
CREATE INDEX `idx_sched_user` ON `scheduled_tasks` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_sched_org` ON `scheduled_tasks` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_sched_active` ON `scheduled_tasks` (`isActive`);--> statement-breakpoint
CREATE INDEX `idx_sched_next_run` ON `scheduled_tasks` (`nextRunAt`);--> statement-breakpoint
CREATE INDEX `idx_sched_source` ON `scheduled_tasks` (`sourceChannelId`);--> statement-breakpoint
CREATE INDEX `idx_sched_target` ON `scheduled_tasks` (`targetChannelId`);