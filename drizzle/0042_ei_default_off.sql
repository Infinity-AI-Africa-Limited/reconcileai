ALTER TABLE `exception_intelligence_settings` MODIFY COLUMN `shareEnabled` boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE `exception_intelligence_settings` MODIFY COLUMN `consumeEnabled` boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- Exception Intelligence launched default-ON; switch it to opt-in. No legitimate
-- opt-ins exist yet (feature just shipped), so reset any auto-created rows to OFF.
UPDATE `exception_intelligence_settings` SET `shareEnabled` = false, `consumeEnabled` = false;