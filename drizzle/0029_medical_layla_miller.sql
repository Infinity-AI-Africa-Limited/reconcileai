CREATE TABLE `cbnDeadlineSubmissions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`frameworkCode` varchar(64) NOT NULL,
	`frameworkName` varchar(255) NOT NULL,
	`periodLabel` varchar(64) NOT NULL,
	`submittedAt` timestamp NOT NULL,
	`submittedByUserId` int,
	`submittedByName` varchar(255),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cbnDeadlineSubmissions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_cbn_deadline_org` ON `cbnDeadlineSubmissions` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_cbn_deadline_code` ON `cbnDeadlineSubmissions` (`frameworkCode`);--> statement-breakpoint
CREATE INDEX `idx_cbn_deadline_period` ON `cbnDeadlineSubmissions` (`frameworkCode`,`periodLabel`);