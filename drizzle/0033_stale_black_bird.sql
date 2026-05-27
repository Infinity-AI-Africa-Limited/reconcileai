CREATE TABLE `cfo_report_schedules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`organizationId` int,
	`scheduleCronTaskUid` varchar(65),
	`isActive` boolean NOT NULL DEFAULT true,
	`cronExpression` varchar(64) NOT NULL DEFAULT '0 0 8 * * 1',
	`recipients` json NOT NULL,
	`reportPeriod` varchar(10) NOT NULL DEFAULT '7d',
	`lastSentAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `cfo_report_schedules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `channel_alert_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`organizationId` int,
	`channelCode` varchar(64) NOT NULL,
	`threshold` decimal(5,2) NOT NULL DEFAULT '95.00',
	`alertEnabled` boolean NOT NULL DEFAULT true,
	`lastAlertSentAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `channel_alert_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_channel_alert_user_channel` UNIQUE(`userId`,`channelCode`)
);
--> statement-breakpoint
CREATE INDEX `idx_cfo_schedule_user` ON `cfo_report_schedules` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_cfo_schedule_org` ON `cfo_report_schedules` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_cfo_schedule_task_uid` ON `cfo_report_schedules` (`scheduleCronTaskUid`);--> statement-breakpoint
CREATE INDEX `idx_channel_alert_user` ON `channel_alert_settings` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_channel_alert_org` ON `channel_alert_settings` (`organizationId`);