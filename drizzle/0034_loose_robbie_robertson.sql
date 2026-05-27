CREATE TABLE `s3_csv_exports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`organizationId` int,
	`s3Key` varchar(512) NOT NULL,
	`s3Url` text NOT NULL,
	`filename` varchar(255) NOT NULL,
	`sourceModule` varchar(32) NOT NULL,
	`sourceId` int,
	`sizeBytes` int NOT NULL DEFAULT 0,
	`retentionDays` int NOT NULL DEFAULT 7,
	`deleted` boolean NOT NULL DEFAULT false,
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `s3_csv_exports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_s3csv_user` ON `s3_csv_exports` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_s3csv_org` ON `s3_csv_exports` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_s3csv_module` ON `s3_csv_exports` (`sourceModule`);--> statement-breakpoint
CREATE INDEX `idx_s3csv_created` ON `s3_csv_exports` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_s3csv_deleted` ON `s3_csv_exports` (`deleted`);