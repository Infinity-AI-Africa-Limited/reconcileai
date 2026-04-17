ALTER TABLE `wc_exceptions` ADD `ref_num` varchar(100);--> statement-breakpoint
ALTER TABLE `wc_exceptions` ADD `description` varchar(500);--> statement-breakpoint
ALTER TABLE `wc_exceptions` ADD `review_status` varchar(20) DEFAULT 'OPEN';--> statement-breakpoint
ALTER TABLE `wc_exceptions` ADD `reviewed_by` varchar(100);--> statement-breakpoint
ALTER TABLE `wc_exceptions` ADD `reviewed_at` datetime;--> statement-breakpoint
ALTER TABLE `wc_exceptions` ADD `review_note` text;