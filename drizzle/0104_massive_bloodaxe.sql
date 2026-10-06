-- Shopify refunds become their own transaction rows, under their ORDER's
-- reference, so they match the gateway's refund lines by reference. The old
-- unique key (organizationId, shopifyStoreId, transactionRef) allows one row
-- per order; shopifyRefundId tells the order's row ('') from its refunds'.
--
-- Two deliberate departures from what drizzle-kit emitted:
--
-- 1. ORDER. The new key is added BEFORE the old one is dropped (drizzle-kit
--    dropped first), so the table is never without a uniqueness backstop while
--    the previous release is still writing orders during the deploy. Existing
--    rows all take '' and the new key is the old one plus a constant for them,
--    so it cannot be violated.
--
-- 2. EVERY STEP IS GUARDED. MySQL DDL is not transactional: if the deploy dies
--    after the column or the new key exists but before the runner records this
--    migration, the next deploy re-runs it from the top, and an unguarded ADD
--    fails on its own object — a permanently broken deploy, as 0090 was. Each
--    step checks information_schema first. `ADD COLUMN IF NOT EXISTS` and
--    `DROP INDEX IF EXISTS` are not used: MySQL 8.0 rejects them (see
--    server/migrationIntegrity.test.ts). On a fresh database every guard runs
--    its statement, so the schema is exactly what drizzle-kit generated.
SET @rfnd_col := (SELECT COUNT(1) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'transactions' AND column_name = 'shopifyRefundId');
--> statement-breakpoint
SET @rfnd_sql1 := IF(@rfnd_col = 0, 'ALTER TABLE `transactions` ADD `shopifyRefundId` varchar(64) DEFAULT '''' NOT NULL', 'SELECT 1');
--> statement-breakpoint
PREPARE rfnd_stmt1 FROM @rfnd_sql1;
--> statement-breakpoint
EXECUTE rfnd_stmt1;
--> statement-breakpoint
DEALLOCATE PREPARE rfnd_stmt1;
--> statement-breakpoint
SET @rfnd_new := (SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'transactions' AND index_name = 'uq_txn_shopify_record');
--> statement-breakpoint
SET @rfnd_sql2 := IF(@rfnd_new = 0, 'ALTER TABLE `transactions` ADD CONSTRAINT `uq_txn_shopify_record` UNIQUE(`organizationId`,`shopifyStoreId`,`transactionRef`,`shopifyRefundId`)', 'SELECT 1');
--> statement-breakpoint
PREPARE rfnd_stmt2 FROM @rfnd_sql2;
--> statement-breakpoint
EXECUTE rfnd_stmt2;
--> statement-breakpoint
DEALLOCATE PREPARE rfnd_stmt2;
--> statement-breakpoint
SET @rfnd_old := (SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'transactions' AND index_name = 'uq_txn_shopify_order');
--> statement-breakpoint
SET @rfnd_sql3 := IF(@rfnd_old > 0, 'ALTER TABLE `transactions` DROP INDEX `uq_txn_shopify_order`', 'SELECT 1');
--> statement-breakpoint
PREPARE rfnd_stmt3 FROM @rfnd_sql3;
--> statement-breakpoint
EXECUTE rfnd_stmt3;
--> statement-breakpoint
DEALLOCATE PREPARE rfnd_stmt3;
