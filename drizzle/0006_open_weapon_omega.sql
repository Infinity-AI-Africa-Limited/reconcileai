CREATE TABLE `guest_sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionId` varchar(64) NOT NULL,
	`guestUserId` int NOT NULL,
	`guestOrganizationId` int NOT NULL,
	`demoDataSeeded` boolean NOT NULL DEFAULT false,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `guest_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `guest_sessions_sessionId_unique` UNIQUE(`sessionId`)
);
--> statement-breakpoint
CREATE INDEX `idx_guest_sessions_expires` ON `guest_sessions` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `idx_guest_sessions_user` ON `guest_sessions` (`guestUserId`);