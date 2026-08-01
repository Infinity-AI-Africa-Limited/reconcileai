-- Durable sync-outcome state for SHOPLINE stores.
--
-- A failed sync cycle previously wrote NOTHING: runSyncCycle returned an error
-- report that only the caller console.warn'd, and `lastSyncAt` stays NULL on
-- failure — so "never ran" and "ran and failed" were indistinguishable without
-- the host's log stream. That ambiguity is what made the 2026-07-31 dev-store
-- order untraceable.
--
-- `lastSyncAttemptAt` is stamped on EVERY attempt (success or failure);
-- `lastSyncError` holds the failure reason and is cleared on success.
ALTER TABLE `sl_connector_stores` ADD `lastSyncAttemptAt` timestamp;--> statement-breakpoint
ALTER TABLE `sl_connector_stores` ADD `lastSyncError` text;