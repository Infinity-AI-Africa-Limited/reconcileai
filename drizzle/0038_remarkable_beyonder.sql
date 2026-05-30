CREATE TABLE `platform_audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`actorId` int NOT NULL,
	`actorName` varchar(255),
	`eventType` enum('org_created','org_segment_updated','user_role_updated','user_promoted_super_admin') NOT NULL,
	`targetType` enum('organization','user') NOT NULL,
	`targetId` int NOT NULL,
	`targetName` varchar(255),
	`previousValue` text,
	`newValue` text,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `platform_audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_pal_actor` ON `platform_audit_logs` (`actorId`);--> statement-breakpoint
CREATE INDEX `idx_pal_event` ON `platform_audit_logs` (`eventType`);--> statement-breakpoint
CREATE INDEX `idx_pal_target` ON `platform_audit_logs` (`targetType`,`targetId`);--> statement-breakpoint
CREATE INDEX `idx_pal_created` ON `platform_audit_logs` (`createdAt`);