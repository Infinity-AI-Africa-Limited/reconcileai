-- The SHOPLINE catch-up watermark, separate from lastSyncAt.
--
-- lastSyncAt is "the last sync that succeeded", and every success wrote it as
-- the wall clock. The 15-minute poll also used it as "fetched through here".
-- Those are not the same thing. A sync over the last 24 hours that succeeds
-- after a three-day outage is a success, but it leaves two days unread, and
-- writing it as the watermark made those days unreachable for good.
-- syncedThroughAt advances only across a window that starts at or before it
-- (recordSyncOutcome, server/connectors/shopline/syncOrchestrator.ts).
--
-- Backfill: until now lastSyncAt WAS the watermark, so it is the best value
-- each store has. A store that has never synced keeps NULL.
ALTER TABLE `sl_connector_stores` ADD `syncedThroughAt` timestamp;
--> statement-breakpoint
UPDATE `sl_connector_stores` SET `syncedThroughAt` = `lastSyncAt` WHERE `syncedThroughAt` IS NULL;
