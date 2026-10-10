ALTER TABLE `control_source_contracts` ADD `channelId` int;--> statement-breakpoint
CREATE INDEX `idx_control_source_contract_org_channel` ON `control_source_contracts` (`organizationId`,`channelId`);