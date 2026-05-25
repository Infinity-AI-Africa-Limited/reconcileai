CREATE TABLE `roadmapAccessRequests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`company` varchar(255),
	`reason` text,
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`accessToken` varchar(128),
	`tokenExpiresAt` timestamp,
	`approvedAt` timestamp,
	`approvedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `roadmapAccessRequests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_roadmap_email` ON `roadmapAccessRequests` (`email`);--> statement-breakpoint
CREATE INDEX `idx_roadmap_status` ON `roadmapAccessRequests` (`status`);--> statement-breakpoint
CREATE INDEX `idx_roadmap_token` ON `roadmapAccessRequests` (`accessToken`);