-- One-time replay of every Shopify store's orders (owner decision, 2026-10-06).
--
-- WHY. Until #169 an order was stored at its total NET of refunds and its
-- refunds were not recorded, so a partially refunded order never matched its own
-- gross payment. #169 stores the total BEFORE refunds and each refund as its own
-- row, but only for orders it reads again. A sync reads from the store's
-- watermark (its last order update seen), so an order refunded before the deploy
-- and not touched since would keep its net total, and no refund rows, for good.
--
-- WHAT. Each store's orders cursor is marked as owing a replay. Its next sync
-- reads from the start of its initial window (SHOPIFY_INITIAL_ORDER_WINDOW_DAYS,
-- 60 days: everything read_orders allows) in 7-day steps, then clears the mark
-- once it has caught up. For each order read:
--   - a row stored net of refunds is restated at its total before them (same
--     Shopify version, different evidence: restatesSameSnapshot), and any match
--     it was in is reopened;
--   - its refunds are written as their own rows;
--   - the sync then re-matches both against settlement evidence already waiting
--     for them (reconcileWithWaitingEvidence), raising no new exceptions;
--   - an order whose customer was redacted stays out: its tombstone still
--     filters it before anything is written.
-- Orders already stored correctly are read and left unchanged.
--
-- WHY A COLUMN, AND NOT A CLEARED WATERMARK. This runs before the deploy, while
-- the previous release is still syncing. A sync that read the old watermark
-- before this ran, and committed after, would advance a cleared watermark past
-- the 60 days and cancel the replay unseen. The previous release never writes
-- replayWatermarkUpdatedAt, and the new one moves it only from the value it read
-- (recordSuccessfulOrderSync), so nothing but the replay itself can clear it.
-- The value set here is a lower bound only: the sync never reads further back
-- than read_orders allows, however old the mark.
--
-- SAFETY. The column step is guarded like 0104's: if the deploy dies after the
-- column exists but before the runner records this migration, the next deploy
-- re-runs it from the top, and an unguarded ADD would fail on its own column.
-- `ADD COLUMN IF NOT EXISTS` is not used: MySQL 8.0 rejects it (see
-- server/migrationIntegrity.test.ts). On a fresh database the guard runs the
-- statement drizzle-kit generated, unchanged. Re-running the UPDATE only marks
-- the replay as owed again. Stores that are uninstalled, fenced for redaction or
-- awaiting reauthorization are untouched by the sync whatever their cursor says.
SET @rply_col := (SELECT COUNT(1) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'shopify_sync_cursors' AND column_name = 'replayWatermarkUpdatedAt');
--> statement-breakpoint
SET @rply_sql := IF(@rply_col = 0, 'ALTER TABLE `shopify_sync_cursors` ADD `replayWatermarkUpdatedAt` timestamp', 'SELECT 1');
--> statement-breakpoint
PREPARE rply_stmt FROM @rply_sql;
--> statement-breakpoint
EXECUTE rply_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE rply_stmt;
--> statement-breakpoint
UPDATE `shopify_sync_cursors` SET `replayWatermarkUpdatedAt` = NOW() - INTERVAL 60 DAY WHERE `resource` = 'orders';
