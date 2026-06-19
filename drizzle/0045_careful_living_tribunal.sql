CREATE TABLE `poc_file_uploads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pocSlug` varchar(64) NOT NULL,
	`fileRole` varchar(32) NOT NULL,
	`originalName` varchar(255) NOT NULL,
	`mimeType` varchar(100) NOT NULL,
	`sizeBytes` int NOT NULL,
	`s3Key` varchar(512) NOT NULL,
	`visitorId` varchar(64),
	`userAgent` varchar(512),
	`runId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `poc_file_uploads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_poc_file_slug` ON `poc_file_uploads` (`pocSlug`);--> statement-breakpoint
CREATE INDEX `idx_poc_file_created` ON `poc_file_uploads` (`createdAt`);