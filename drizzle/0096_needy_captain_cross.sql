ALTER TABLE `transactions` ADD `shopifyStoreId` int;--> statement-breakpoint
ALTER TABLE `transactions` ADD `shopifyOrderCurrency` varchar(3);--> statement-breakpoint
ALTER TABLE `transactions` ADD `shopifyUpdatedAt` timestamp;--> statement-breakpoint
ALTER TABLE `transactions` ADD `shopifyFinancialStatus` varchar(64);--> statement-breakpoint
ALTER TABLE `transactions` ADD `shopifyCancelledAt` timestamp;--> statement-breakpoint
ALTER TABLE `transactions` ADD CONSTRAINT `uq_txn_shopify_order` UNIQUE(`organizationId`,`shopifyStoreId`,`transactionRef`);