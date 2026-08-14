ALTER TABLE `organizations` ADD `isDemo` boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill from the naming convention that has been the de-facto marker all
-- along (CLAUDE.md §19 uses "name contains Demo" as its own first-customer
-- check). Marks Globus Bank Nigeria (Demo), BrightGoods Nigeria Ltd (Demo) and
-- ReconcileAI Dev Store. Deliberately conservative: an organisation whose name
-- carries no signal is left as NOT demo, because wrongly marking a real tenant
-- would silence its genuine SLA alerts — the more dangerous direction of the two.
UPDATE `organizations`
   SET `isDemo` = true
 WHERE `name` LIKE '%(Demo)%'
    OR `name` LIKE '%Demo %'
    OR `name` LIKE '%Dev Store%';
