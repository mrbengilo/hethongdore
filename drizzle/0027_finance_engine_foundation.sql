CREATE TABLE IF NOT EXISTS `financial_policy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`effective_from_period` text NOT NULL,
	`policy_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`superseded_at` text,
	CONSTRAINT `financial_policy_versions_version_positive` CHECK (`version` > 0),
	CONSTRAINT `financial_policy_versions_effective_period_format` CHECK (`effective_from_period` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND CAST(substr(`effective_from_period`, 6, 2) AS integer) BETWEEN 1 AND 12),
	CONSTRAINT `financial_policy_versions_policy_json_valid` CHECK (json_valid(`policy_json`) AND json_type(`policy_json`) = 'object'),
	CONSTRAINT `financial_policy_versions_superseded_timestamp` CHECK (`superseded_at` IS NULL OR length(trim(`superseded_at`)) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_financial_policy_versions_version` ON `financial_policy_versions` (`version`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_financial_policy_versions_effective` ON `financial_policy_versions` (`effective_from_period`,`version`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `financial_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`period` text NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`policy_version_id` text,
	`config_version` integer,
	`revision` integer DEFAULT 0 NOT NULL,
	`gross_revenue` integer DEFAULT 0 NOT NULL,
	`fixed_expense` integer DEFAULT 0 NOT NULL,
	`variable_expense` integer DEFAULT 0 NOT NULL,
	`inventory_cost` integer DEFAULT 0 NOT NULL,
	`inventory_shipping_cost` integer DEFAULT 0 NOT NULL,
	`employee_salary` integer DEFAULT 0 NOT NULL,
	`manager_salary` integer DEFAULT 0 NOT NULL,
	`manual_bonus` integer DEFAULT 0 NOT NULL,
	`allowance` integer DEFAULT 0 NOT NULL,
	`total_hours_seconds` integer DEFAULT 0 NOT NULL,
	`employee_kpi_total` integer DEFAULT 0 NOT NULL,
	`manager_kpi` integer DEFAULT 0 NOT NULL,
	`operating_profit` integer DEFAULT 0 NOT NULL,
	`profit_after_kpi` integer DEFAULT 0 NOT NULL,
	`month_end_expense` integer DEFAULT 0 NOT NULL,
	`final_profit` integer DEFAULT 0 NOT NULL,
	`distributable_profit` integer DEFAULT 0 NOT NULL,
	`salary_advance` integer DEFAULT 0 NOT NULL,
	`employee_payroll_rows_json` text DEFAULT '[]' NOT NULL,
	`manager_payroll_json` text DEFAULT '{}' NOT NULL,
	`config_snapshot_json` text DEFAULT '{}' NOT NULL,
	`snapshot_json` text DEFAULT '{}' NOT NULL,
	`calculated_at` text,
	`calculated_by` text,
	`confirmed_at` text,
	`confirmed_by` text,
	`paid_at` text,
	`paid_by` text,
	`locked_at` text,
	`locked_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`policy_version_id`) REFERENCES `financial_policy_versions`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT `financial_periods_period_format` CHECK (`period` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND CAST(substr(`period`, 6, 2) AS integer) BETWEEN 1 AND 12),
	CONSTRAINT `financial_periods_status` CHECK (`status` IN ('DRAFT', 'CALCULATED', 'RECONCILING', 'CONFIRMED', 'PAID', 'LOCKED')),
	CONSTRAINT `financial_periods_config_version` CHECK (`config_version` IS NULL OR `config_version` > 0),
	CONSTRAINT `financial_periods_nonnegative_inputs` CHECK (
		`revision` >= 0 AND `gross_revenue` >= 0 AND `fixed_expense` >= 0 AND `variable_expense` >= 0 AND
		`inventory_cost` >= 0 AND `inventory_shipping_cost` >= 0 AND `employee_salary` >= 0 AND
		`manager_salary` >= 0 AND `manual_bonus` >= 0 AND `allowance` >= 0 AND
		`total_hours_seconds` >= 0 AND `employee_kpi_total` >= 0 AND `manager_kpi` >= 0 AND
		`month_end_expense` >= 0 AND `distributable_profit` >= 0 AND `salary_advance` >= 0
	),
	CONSTRAINT `financial_periods_json_valid` CHECK (
		json_valid(`employee_payroll_rows_json`) AND json_type(`employee_payroll_rows_json`) = 'array' AND
		json_valid(`manager_payroll_json`) AND json_type(`manager_payroll_json`) = 'object' AND
		json_valid(`config_snapshot_json`) AND json_type(`config_snapshot_json`) = 'object' AND
		json_valid(`snapshot_json`) AND json_type(`snapshot_json`) = 'object'
	),
	CONSTRAINT `financial_periods_policy_version_pair` CHECK ((`policy_version_id` IS NULL AND `config_version` IS NULL) OR (`policy_version_id` IS NOT NULL AND `config_version` IS NOT NULL)),
	CONSTRAINT `financial_periods_calculated_pair` CHECK ((`calculated_at` IS NULL AND `calculated_by` IS NULL) OR (`calculated_at` IS NOT NULL AND `calculated_by` IS NOT NULL)),
	CONSTRAINT `financial_periods_confirmed_pair` CHECK ((`confirmed_at` IS NULL AND `confirmed_by` IS NULL) OR (`confirmed_at` IS NOT NULL AND `confirmed_by` IS NOT NULL)),
	CONSTRAINT `financial_periods_paid_pair` CHECK ((`paid_at` IS NULL AND `paid_by` IS NULL) OR (`paid_at` IS NOT NULL AND `paid_by` IS NOT NULL)),
	CONSTRAINT `financial_periods_locked_pair` CHECK ((`locked_at` IS NULL AND `locked_by` IS NULL) OR (`locked_at` IS NOT NULL AND `locked_by` IS NOT NULL)),
	CONSTRAINT `financial_periods_lifecycle_metadata` CHECK (
		(`status` = 'DRAFT' AND `calculated_at` IS NULL AND `confirmed_at` IS NULL AND `paid_at` IS NULL AND `locked_at` IS NULL) OR
		(`status` IN ('CALCULATED', 'RECONCILING') AND `calculated_at` IS NOT NULL AND `confirmed_at` IS NULL AND `paid_at` IS NULL AND `locked_at` IS NULL) OR
		(`status` = 'CONFIRMED' AND `calculated_at` IS NOT NULL AND `confirmed_at` IS NOT NULL AND `paid_at` IS NULL AND `locked_at` IS NULL AND `policy_version_id` IS NOT NULL AND json_extract(`snapshot_json`, '$.schemaVersion') IS 1) OR
		(`status` = 'PAID' AND `calculated_at` IS NOT NULL AND `confirmed_at` IS NOT NULL AND `paid_at` IS NOT NULL AND `locked_at` IS NULL AND `policy_version_id` IS NOT NULL AND json_extract(`snapshot_json`, '$.schemaVersion') IS 1) OR
		(`status` = 'LOCKED' AND `calculated_at` IS NOT NULL AND `confirmed_at` IS NOT NULL AND `paid_at` IS NOT NULL AND `locked_at` IS NOT NULL AND `policy_version_id` IS NOT NULL AND json_extract(`snapshot_json`, '$.schemaVersion') IS 1)
	),
	CONSTRAINT `financial_periods_lifecycle_order` CHECK ((`confirmed_at` IS NULL OR `confirmed_at` >= `calculated_at`) AND (`paid_at` IS NULL OR `paid_at` >= `confirmed_at`) AND (`locked_at` IS NULL OR `locked_at` >= `paid_at`)),
	CONSTRAINT `financial_periods_operating_profit_formula` CHECK (`operating_profit` = `gross_revenue` - `fixed_expense` - `variable_expense` - `inventory_cost` - `inventory_shipping_cost` - `employee_salary` - `manager_salary` - `manual_bonus` - `allowance`),
	CONSTRAINT `financial_periods_profit_after_kpi_formula` CHECK (`profit_after_kpi` = `operating_profit` - `employee_kpi_total` - `manager_kpi`),
	CONSTRAINT `financial_periods_final_profit_formula` CHECK (`final_profit` = `profit_after_kpi` - `month_end_expense`),
	CONSTRAINT `financial_periods_distributable_profit_formula` CHECK (`distributable_profit` = CASE WHEN `final_profit` > 0 THEN `final_profit` ELSE 0 END)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_financial_periods_store_period` ON `financial_periods` (`store_id`,`period`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_financial_periods_status_period` ON `financial_periods` (`status`,`period`,`store_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_financial_periods_store_status` ON `financial_periods` (`store_id`,`status`,`period`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `month_end_expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`period` text NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`amount` integer NOT NULL,
	`note` text,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`client_request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL,
	`voided_by` text,
	`voided_at` text,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT `month_end_expenses_period_format` CHECK (`period` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND CAST(substr(`period`, 6, 2) AS integer) BETWEEN 1 AND 12),
	CONSTRAINT `month_end_expenses_text_nonempty` CHECK (length(trim(`title`)) > 0 AND length(trim(`category`)) > 0 AND length(trim(`client_request_id`)) > 0 AND length(trim(`payload_hash`)) > 0),
	CONSTRAINT `month_end_expenses_amount` CHECK (`amount` > 0),
	CONSTRAINT `month_end_expenses_version` CHECK (`version` > 0),
	CONSTRAINT `month_end_expenses_void_metadata` CHECK ((`status` = 'ACTIVE' AND `voided_by` IS NULL AND `voided_at` IS NULL) OR (`status` = 'VOID' AND `voided_by` IS NOT NULL AND `voided_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_month_end_expenses_actor_request` ON `month_end_expenses` (`store_id`,`created_by`,`client_request_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_month_end_expenses_store_period_status` ON `month_end_expenses` (`store_id`,`period`,`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cashflow_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`direction` text NOT NULL,
	`amount` integer NOT NULL,
	`category` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_by` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT `cashflow_entries_direction` CHECK (`direction` IN ('IN', 'OUT')),
	CONSTRAINT `cashflow_entries_amount` CHECK (`amount` > 0),
	CONSTRAINT `cashflow_entries_text_nonempty` CHECK (length(trim(`category`)) > 0 AND length(trim(`source_type`)) > 0 AND length(trim(`source_id`)) > 0 AND length(trim(`occurred_at`)) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_cashflow_entries_source` ON `cashflow_entries` (`store_id`,`source_type`,`source_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cashflow_entries_store_occurred` ON `cashflow_entries` (`store_id`,`occurred_at`,`id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cashflow_entries_source_lookup` ON `cashflow_entries` (`source_type`,`source_id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_financial_periods_locked_update` BEFORE UPDATE ON `financial_periods` WHEN OLD.`status` = 'LOCKED' BEGIN SELECT RAISE(ABORT, 'LOCKED financial period is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_financial_periods_locked_delete` BEFORE DELETE ON `financial_periods` WHEN OLD.`status` = 'LOCKED' BEGIN SELECT RAISE(ABORT, 'LOCKED financial period is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_financial_policy_versions_immutable_update`
BEFORE UPDATE ON `financial_policy_versions`
WHEN NOT (OLD.`superseded_at` IS NULL AND NEW.`superseded_at` IS NOT NULL AND NEW.`id` IS OLD.`id` AND NEW.`version` IS OLD.`version` AND NEW.`effective_from_period` IS OLD.`effective_from_period` AND NEW.`policy_json` IS OLD.`policy_json` AND NEW.`created_by` IS OLD.`created_by` AND NEW.`created_at` IS OLD.`created_at`)
BEGIN SELECT RAISE(ABORT, 'financial policy versions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_financial_policy_versions_immutable_delete` BEFORE DELETE ON `financial_policy_versions` BEGIN SELECT RAISE(ABORT, 'financial policy versions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_month_end_expenses_locked_insert`
BEFORE INSERT ON `month_end_expenses`
WHEN EXISTS (SELECT 1 FROM `financial_periods` WHERE `store_id` = NEW.`store_id` AND `period` = NEW.`period` AND `status` = 'LOCKED')
BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept month-end expenses'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_month_end_expenses_locked_update`
BEFORE UPDATE ON `month_end_expenses`
WHEN EXISTS (SELECT 1 FROM `financial_periods` WHERE `store_id` = OLD.`store_id` AND `period` = OLD.`period` AND `status` = 'LOCKED') OR EXISTS (SELECT 1 FROM `financial_periods` WHERE `store_id` = NEW.`store_id` AND `period` = NEW.`period` AND `status` = 'LOCKED')
BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept month-end expense changes'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_month_end_expenses_locked_delete`
BEFORE DELETE ON `month_end_expenses`
WHEN EXISTS (SELECT 1 FROM `financial_periods` WHERE `store_id` = OLD.`store_id` AND `period` = OLD.`period` AND `status` = 'LOCKED')
BEGIN SELECT RAISE(ABORT, 'LOCKED financial period does not accept month-end expense changes'); END;
--> statement-breakpoint
-- Audit-log compatibility columns are intentionally owned by db/runtime.ts. SQLite
-- does not support ADD COLUMN IF NOT EXISTS, so keeping ALTER TABLE statements in
-- both authorities makes a supported migration-then-runtime deployment collide.
