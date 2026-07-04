ALTER TABLE `mm_exceptions` MODIFY COLUMN `operator` enum('nip','opay','palmpay','mtn_momo_ug','airtel_money_ug') NOT NULL;--> statement-breakpoint
ALTER TABLE `mm_runs` MODIFY COLUMN `operator` enum('nip','opay','palmpay','mtn_momo_ug','airtel_money_ug') NOT NULL;
