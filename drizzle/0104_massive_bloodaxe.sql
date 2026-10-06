-- Shopify refunds become their own transaction rows, under their ORDER's
-- reference, so they match the gateway's refund lines by reference. The old
-- unique key (organizationId, shopifyStoreId, transactionRef) allows one row
-- per order; shopifyRefundId tells the order's row ('') from its refunds'.
--
-- Order of statements is deliberate, and differs from what drizzle-kit emitted
-- (drop first): the new key is added BEFORE the old one is dropped, so the
-- table is never without a uniqueness backstop while the previous release is
-- still writing orders during the deploy. Existing rows all take '' and the new
-- key is the old one plus a constant for them, so it cannot be violated.
ALTER TABLE `transactions` ADD `shopifyRefundId` varchar(64) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD CONSTRAINT `uq_txn_shopify_record` UNIQUE(`organizationId`,`shopifyStoreId`,`transactionRef`,`shopifyRefundId`);--> statement-breakpoint
ALTER TABLE `transactions` DROP INDEX `uq_txn_shopify_order`;
