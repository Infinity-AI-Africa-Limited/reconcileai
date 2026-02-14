CREATE TABLE `api_ingestion_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`apiKeyId` int,
	`endpoint` varchar(255) NOT NULL,
	`method` varchar(10) NOT NULL,
	`channelId` int,
	`fileName` varchar(500),
	`fileHash` varchar(64),
	`payloadSize` int,
	`totalRows` int,
	`validRows` int,
	`invalidRows` int,
	`status` enum('success','failed','partial') NOT NULL,
	`statusCode` int,
	`errorMessage` text,
	`processingTimeMs` int,
	`uploadBatchId` int,
	`reconciliationJobId` int,
	`ipAddress` varchar(45),
	`userAgent` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `api_ingestion_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sftp_credentials` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`host` varchar(255) NOT NULL,
	`port` int NOT NULL DEFAULT 22,
	`username` varchar(255) NOT NULL,
	`passwordEncrypted` text,
	`privateKeyEncrypted` text,
	`remotePath` varchar(500) NOT NULL DEFAULT '/',
	`filePattern` varchar(255) NOT NULL DEFAULT '*.csv',
	`archivePath` varchar(500),
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
	`totalFilesFailed` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sftp_credentials_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sftp_ingestion_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sftpCredentialId` int NOT NULL,
	`organizationId` int,
	`channelId` int,
	`fileName` varchar(500) NOT NULL,
	`filePath` varchar(1000) NOT NULL,
	`fileSize` bigint,
	`fileHash` varchar(64),
	`totalRows` int,
	`validRows` int,
	`invalidRows` int,
	`status` enum('success','failed','partial','skipped') NOT NULL,
	`errorMessage` text,
	`processingTimeMs` int,
	`uploadBatchId` int,
	`reconciliationJobId` int,
	`archivedPath` varchar(1000),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sftp_ingestion_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_role_preferences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`organizationId` int,
	`defaultView` enum('cfo','operations','auditor','standard') NOT NULL DEFAULT 'standard',
	`visibleWidgets` json,
	`widgetOrder` json,
	`defaultChannelFilter` json,
	`defaultDateRange` varchar(50) NOT NULL DEFAULT '7d',
	`desktopNotifications` boolean NOT NULL DEFAULT false,
	`emailDigestFrequency` enum('none','daily','weekly') NOT NULL DEFAULT 'none',
	`theme` enum('light','dark','auto') NOT NULL DEFAULT 'light',
	`compactMode` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_role_preferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_role_pref_user_org` UNIQUE(`userId`,`organizationId`)
);
--> statement-breakpoint
CREATE INDEX `idx_api_log_org` ON `api_ingestion_logs` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_api_log_key` ON `api_ingestion_logs` (`apiKeyId`);--> statement-breakpoint
CREATE INDEX `idx_api_log_status` ON `api_ingestion_logs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_api_log_created` ON `api_ingestion_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_api_log_batch` ON `api_ingestion_logs` (`uploadBatchId`);--> statement-breakpoint
CREATE INDEX `idx_api_log_hash` ON `api_ingestion_logs` (`fileHash`);--> statement-breakpoint
CREATE INDEX `idx_sftp_org` ON `sftp_credentials` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_sftp_user` ON `sftp_credentials` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_sftp_channel` ON `sftp_credentials` (`channelId`);--> statement-breakpoint
CREATE INDEX `idx_sftp_active` ON `sftp_credentials` (`isActive`);--> statement-breakpoint
CREATE INDEX `idx_sftp_polling` ON `sftp_credentials` (`pollingEnabled`);--> statement-breakpoint
CREATE INDEX `idx_sftp_log_cred` ON `sftp_ingestion_logs` (`sftpCredentialId`);--> statement-breakpoint
CREATE INDEX `idx_sftp_log_org` ON `sftp_ingestion_logs` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_sftp_log_status` ON `sftp_ingestion_logs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sftp_log_created` ON `sftp_ingestion_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_sftp_log_hash` ON `sftp_ingestion_logs` (`fileHash`);--> statement-breakpoint
CREATE INDEX `idx_role_pref_user` ON `user_role_preferences` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_role_pref_view` ON `user_role_preferences` (`defaultView`);