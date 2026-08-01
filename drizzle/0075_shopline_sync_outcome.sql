-- Durable sync-outcome state for SHOPLINE stores.
--
-- Before this, a failed sync cycle wrote NOTHING to the database: runSyncCycle
-- returned an error report that was only console.warn'd by the realtime
-- scheduler. `lastSyncAt` stays NULL on failure, so "never ran" and "ran and
-- failed" were indistinguishable without the host's log stream — which is
-- exactly the ambiguity that made the 2026-07-31 dev-store order untraceable.
--
-- `lastSyncAttemptAt` is stamped on EVERY attempt (success or failure);
-- `lastSyncError` holds the failure reason and is cleared on success.
ALTER TABLE `sl_connector_stores` ADD `lastSyncAttemptAt` timestamp;
--> statement-breakpoint
ALTER TABLE `sl_connector_stores` ADD `lastSyncError` text;
