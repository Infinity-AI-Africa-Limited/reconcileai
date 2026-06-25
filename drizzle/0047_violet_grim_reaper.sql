ALTER TABLE `exceptions` ADD `cbsStillAnomalous` boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE `exceptions` ADD `cbsVerificationNote` text;--> statement-breakpoint
ALTER TABLE `exceptions` ADD `userKeptResolved` boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE `wc_exceptions` ADD `cbs_verified_at` datetime;--> statement-breakpoint
ALTER TABLE `wc_exceptions` ADD `cbs_still_anomalous` tinyint;--> statement-breakpoint
ALTER TABLE `wc_exceptions` ADD `cbs_verification_note` varchar(300);--> statement-breakpoint
ALTER TABLE `wc_exceptions` ADD `user_kept_resolved` tinyint DEFAULT 0;