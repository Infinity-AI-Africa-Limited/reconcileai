ALTER TABLE `resolution_templates` ADD `dedupe_key` varchar(191);--> statement-breakpoint
ALTER TABLE `resolution_templates` ADD CONSTRAINT `uniq_resolution_template_dedupe` UNIQUE(`dedupe_key`);