CREATE TABLE `magic_link_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`token` varchar(128) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`usedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `magic_link_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_magic_link_token` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE INDEX `idx_magic_link_user` ON `magic_link_tokens` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_magic_link_expires` ON `magic_link_tokens` (`expiresAt`);