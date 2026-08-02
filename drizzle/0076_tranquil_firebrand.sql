CREATE TABLE `bucket_ingestion_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`bucketSourceId` int NOT NULL,
	`organizationId` int NOT NULL,
	`channelId` int NOT NULL,
	`objectKey` varchar(1000) NOT NULL,
	`fileSize` int,
	`fileHash` varchar(64),
	`totalRows` int,
	`validRows` int,
	`invalidRows` int,
	`status` enum('success','failed','partial','skipped') NOT NULL,
	`errorMessage` text,
	`processingTimeMs` int,
	`uploadBatchId` int,
	`reconciliationJobId` int,
	`archivedKey` varchar(1000),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bucket_ingestion_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bucket_ingestion_sources` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`provider` enum('s3','r2','minio','other') NOT NULL DEFAULT 's3',
	`bucket` varchar(255) NOT NULL,
	`prefix` varchar(500) NOT NULL DEFAULT '',
	`region` varchar(64) NOT NULL DEFAULT 'auto',
	`endpoint` varchar(500),
	`accessKeyIdEncrypted` text,
	`secretAccessKeyEncrypted` text,
	`filePattern` varchar(255) NOT NULL DEFAULT '*.csv',
	`archivePrefix` varchar(500),
	`deleteAfterProcess` boolean NOT NULL DEFAULT false,
	`channelId` int NOT NULL,
	`pollingEnabled` boolean NOT NULL DEFAULT true,
	`pollingIntervalMinutes` int NOT NULL DEFAULT 15,
	`autoReconcile` boolean NOT NULL DEFAULT false,
	`reconcileTargetChannelId` int,
	`isActive` boolean NOT NULL DEFAULT true,
	`lastPolledAt` timestamp,
	`lastSuccessAt` timestamp,
	`lastErrorAt` timestamp,
	`lastErrorMessage` text,
	`totalFilesProcessed` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bucket_ingestion_sources_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_bucket_log_src` ON `bucket_ingestion_logs` (`bucketSourceId`);--> statement-breakpoint
CREATE INDEX `idx_bucket_log_org` ON `bucket_ingestion_logs` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_bucket_log_status` ON `bucket_ingestion_logs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_bucket_log_hash` ON `bucket_ingestion_logs` (`fileHash`);--> statement-breakpoint
CREATE INDEX `idx_bucket_log_created` ON `bucket_ingestion_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_bucket_src_org` ON `bucket_ingestion_sources` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_bucket_src_channel` ON `bucket_ingestion_sources` (`channelId`);--> statement-breakpoint
CREATE INDEX `idx_bucket_src_active` ON `bucket_ingestion_sources` (`isActive`);