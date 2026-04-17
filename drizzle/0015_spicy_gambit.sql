ALTER TABLE `wc_acc_gl_journal_entry` MODIFY COLUMN `entry_date` varchar(10) NOT NULL;--> statement-breakpoint
ALTER TABLE `wc_exceptions` MODIFY COLUMN `gl_entry_date` varchar(10);--> statement-breakpoint
ALTER TABLE `wc_m_loan_transaction` MODIFY COLUMN `transaction_date` varchar(10) NOT NULL;--> statement-breakpoint
ALTER TABLE `wc_m_savings_account` MODIFY COLUMN `activated_on_date` varchar(10);--> statement-breakpoint
ALTER TABLE `wc_m_savings_account_transaction` MODIFY COLUMN `transaction_date` varchar(10) NOT NULL;--> statement-breakpoint
ALTER TABLE `wc_reconciliation_runs` MODIFY COLUMN `reconciliation_date` varchar(10) NOT NULL;--> statement-breakpoint
ALTER TABLE `wc_reconciliation_runs` MODIFY COLUMN `period_start` varchar(10) NOT NULL;--> statement-breakpoint
ALTER TABLE `wc_reconciliation_runs` MODIFY COLUMN `period_end` varchar(10) NOT NULL;