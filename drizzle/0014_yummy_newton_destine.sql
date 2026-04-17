CREATE TABLE `wc_acc_gl_account` (
	`id` bigint NOT NULL,
	`name` varchar(150) NOT NULL,
	`gl_code` varchar(100),
	`disabled` tinyint DEFAULT 0,
	`manual_entries_allowed` tinyint DEFAULT 1,
	`classification_enum` smallint,
	`account_usage` smallint,
	`parent_id` bigint,
	`hierarchy` varchar(50),
	`tag_id` bigint,
	`description` varchar(500),
	`organization_running_balance` decimal(19,6) DEFAULT '0',
	CONSTRAINT `wc_acc_gl_account_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_acc_gl_journal_entry` (
	`id` bigint NOT NULL,
	`account_id` bigint NOT NULL,
	`office_id` bigint NOT NULL,
	`reversal_id` bigint,
	`currency_code` varchar(3) NOT NULL,
	`transaction_id` varchar(50) NOT NULL,
	`loan_transaction_id` bigint,
	`savings_transaction_id` bigint,
	`reversed` tinyint DEFAULT 0,
	`ref_num` varchar(100),
	`manual_entry` tinyint DEFAULT 0,
	`entry_date` date NOT NULL,
	`type_enum` smallint NOT NULL,
	`amount` decimal(30,6),
	`description` varchar(500),
	`created_date` datetime NOT NULL,
	`unique_ref_key` varchar(100),
	CONSTRAINT `wc_acc_gl_journal_entry_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_acc_product_mapping` (
	`id` bigint NOT NULL,
	`gl_account_id` bigint NOT NULL,
	`product_id` bigint NOT NULL,
	`product_type` smallint NOT NULL,
	`charge_id` bigint,
	`payment_type_id` bigint,
	`financial_account_type` smallint NOT NULL,
	CONSTRAINT `wc_acc_product_mapping_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_acc_to_gl_journal_entry` (
	`id` bigint NOT NULL,
	`transaction_id` varchar(50) NOT NULL,
	`reversed_transaction_id` varchar(50),
	`reversed` int DEFAULT 0,
	CONSTRAINT `wc_acc_to_gl_journal_entry_id` PRIMARY KEY(`id`),
	CONSTRAINT `wc_acc_to_gl_journal_entry_transaction_id_unique` UNIQUE(`transaction_id`)
);
--> statement-breakpoint
CREATE TABLE `wc_acc_to_gl_journal_entry_savings` (
	`id` bigint NOT NULL,
	`acc_to_gl_transaction_id` bigint NOT NULL,
	`savings_id` bigint NOT NULL,
	`savings_transaction_id` bigint NOT NULL,
	`reversed` int DEFAULT 0,
	CONSTRAINT `wc_acc_to_gl_journal_entry_savings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_exceptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`reconciliation_run_id` int NOT NULL,
	`gl_entry_id` bigint NOT NULL,
	`exception_category` varchar(50) NOT NULL,
	`exception_contribution` decimal(30,6),
	`gl_entry_amount` decimal(30,6),
	`gl_entry_date` date,
	`gl_entry_type` varchar(10),
	`manual_entry_flag` tinyint DEFAULT 0,
	`linked_transaction_id` varchar(50),
	`linked_savings_txn_id` bigint,
	`linked_savings_account_id` bigint,
	`linked_product_id` bigint,
	`product_match` tinyint,
	`agent_classification` varchar(50),
	`agent_explanation` text,
	`agent_confidence` int,
	`recommended_action` text,
	`priority_level` varchar(10),
	`passed_to_layer3` tinyint DEFAULT 0,
	`layer3_processed` tinyint DEFAULT 0,
	`created_at` datetime NOT NULL,
	CONSTRAINT `wc_exceptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_m_loan` (
	`id` bigint NOT NULL,
	`account_no` varchar(20),
	`client_id` bigint,
	`product_id` bigint NOT NULL,
	`loan_status_id` int,
	`principal_amount` decimal(19,6),
	`approved_principal` decimal(19,6),
	`currency_code` varchar(3),
	CONSTRAINT `wc_m_loan_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_m_loan_transaction` (
	`id` bigint NOT NULL,
	`loan_id` bigint NOT NULL,
	`transaction_type_enum` smallint NOT NULL,
	`is_reversed` tinyint NOT NULL DEFAULT 0,
	`transaction_date` date NOT NULL,
	`amount` decimal(19,6),
	`principal_portion_derived` decimal(19,6),
	`interest_portion_derived` decimal(19,6),
	`created_date` datetime NOT NULL,
	CONSTRAINT `wc_m_loan_transaction_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_m_product_loan` (
	`id` bigint NOT NULL,
	`name` varchar(100) NOT NULL,
	`short_name` varchar(4),
	`currency_code` varchar(3),
	`nominal_interest_rate_per_period` decimal(19,6),
	CONSTRAINT `wc_m_product_loan_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_m_savings_account` (
	`id` bigint NOT NULL,
	`account_no` varchar(20) NOT NULL,
	`client_id` bigint,
	`product_id` bigint NOT NULL,
	`status_enum` smallint,
	`currency_code` varchar(3),
	`account_balance_derived` decimal(30,6),
	`activated_on_date` date,
	CONSTRAINT `wc_m_savings_account_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_m_savings_account_transaction` (
	`id` bigint NOT NULL,
	`savings_account_id` bigint NOT NULL,
	`transaction_type_enum` smallint NOT NULL,
	`is_reversed` tinyint NOT NULL DEFAULT 0,
	`transaction_date` date NOT NULL,
	`amount` decimal(30,6),
	`running_balance_derived` decimal(30,6),
	`is_manual` tinyint DEFAULT 0,
	`created_date` datetime NOT NULL,
	CONSTRAINT `wc_m_savings_account_transaction_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_m_savings_product` (
	`id` bigint NOT NULL,
	`name` varchar(100) NOT NULL,
	`short_name` varchar(4),
	`description` varchar(500),
	`deposit_amount` decimal(19,6),
	`currency_code` varchar(3),
	`nominal_annual_interest_rate` decimal(19,6),
	CONSTRAINT `wc_m_savings_product_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wc_reconciliation_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`product_id` bigint NOT NULL,
	`product_name` varchar(100) NOT NULL,
	`product_type` varchar(10) NOT NULL,
	`portfolio_ledger_account_id` bigint NOT NULL,
	`portfolio_ledger_gl_code` varchar(100),
	`reconciliation_date` date NOT NULL,
	`period_start` date NOT NULL,
	`period_end` date NOT NULL,
	`expected_balance` decimal(30,6),
	`actual_gl_balance` decimal(30,6),
	`variance_amount` decimal(30,6),
	`variance_direction` varchar(20),
	`status` varchar(20) NOT NULL,
	`threshold_applied` decimal(30,6) DEFAULT '0',
	`layer2_triggered` tinyint DEFAULT 0,
	`currency_code` varchar(3) DEFAULT 'NGN',
	`total_gl_entries` int DEFAULT 0,
	`total_savings_txns` int DEFAULT 0,
	`created_at` datetime NOT NULL,
	CONSTRAINT `wc_reconciliation_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_wc_gl_account` ON `wc_acc_gl_journal_entry` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_wc_gl_entry_date` ON `wc_acc_gl_journal_entry` (`entry_date`);--> statement-breakpoint
CREATE INDEX `idx_wc_gl_transaction_id` ON `wc_acc_gl_journal_entry` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_wc_bridge_savings_txn` ON `wc_acc_to_gl_journal_entry_savings` (`savings_transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_wc_bridge_acc_to_gl` ON `wc_acc_to_gl_journal_entry_savings` (`acc_to_gl_transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_wc_exc_run` ON `wc_exceptions` (`reconciliation_run_id`);--> statement-breakpoint
CREATE INDEX `idx_wc_exc_category` ON `wc_exceptions` (`exception_category`);--> statement-breakpoint
CREATE INDEX `idx_wc_savings_product` ON `wc_m_savings_account` (`product_id`);--> statement-breakpoint
CREATE INDEX `idx_wc_sat_account` ON `wc_m_savings_account_transaction` (`savings_account_id`);--> statement-breakpoint
CREATE INDEX `idx_wc_sat_date` ON `wc_m_savings_account_transaction` (`transaction_date`);