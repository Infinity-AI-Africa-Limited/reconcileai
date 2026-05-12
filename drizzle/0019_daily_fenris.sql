CREATE TABLE `compliance_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`dpoName` varchar(255),
	`dpoEmail` varchar(320),
	`dpoPhone` varchar(50),
	`retentionPeriodDays` int NOT NULL DEFAULT 1825,
	`autoDeleteEnabled` boolean NOT NULL DEFAULT false,
	`ndpaCompliant` boolean NOT NULL DEFAULT false,
	`ndprCompliant` boolean NOT NULL DEFAULT false,
	`ropaCompleted` boolean NOT NULL DEFAULT false,
	`lastAuditDate` timestamp,
	`nextAuditDate` timestamp,
	`breachNotificationEmail` varchar(320),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `compliance_settings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `data_deletion_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`requestedByUserId` int NOT NULL,
	`requestedAt` timestamp NOT NULL DEFAULT (now()),
	`scope` enum('all_transactions','specific_channel','specific_job','all_data') NOT NULL DEFAULT 'all_data',
	`channelId` int,
	`jobId` int,
	`status` enum('pending','in_progress','completed','failed') NOT NULL DEFAULT 'pending',
	`completedAt` timestamp,
	`recordsDeleted` bigint DEFAULT 0,
	`certificateText` text,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `data_deletion_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `security_incidents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int,
	`reportedByUserId` int NOT NULL,
	`reportedAt` timestamp NOT NULL DEFAULT (now()),
	`incidentType` enum('unauthorised_access','data_breach','unauthorised_disclosure','system_compromise','other') NOT NULL DEFAULT 'other',
	`severity` enum('low','medium','high','critical') NOT NULL DEFAULT 'medium',
	`description` text NOT NULL,
	`affectedDataTypes` json,
	`estimatedRecordsAffected` int,
	`counterpartyNotifiedAt` timestamp,
	`counterpartyNotifiedVia` varchar(100),
	`regulatorNotifiedAt` timestamp,
	`status` enum('open','investigating','contained','resolved') NOT NULL DEFAULT 'open',
	`resolvedAt` timestamp,
	`resolutionNotes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `security_incidents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_compliance_org` ON `compliance_settings` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_deletion_org` ON `data_deletion_requests` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_deletion_status` ON `data_deletion_requests` (`status`);--> statement-breakpoint
CREATE INDEX `idx_incidents_org` ON `security_incidents` (`organizationId`);--> statement-breakpoint
CREATE INDEX `idx_incidents_status` ON `security_incidents` (`status`);--> statement-breakpoint
CREATE INDEX `idx_incidents_severity` ON `security_incidents` (`severity`);