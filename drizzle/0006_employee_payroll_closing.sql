ALTER TABLE `employees` ADD `inactive_at` text;
--> statement-breakpoint
CREATE TABLE `employee_payroll_closings` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`period` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`employee_status_at_lock` text NOT NULL,
	`status` text DEFAULT 'LOCKED' NOT NULL,
	`locked_at` text NOT NULL,
	`locked_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_employee_payroll_closing_period` ON `employee_payroll_closings` (`store_id`,`employee_id`,`period`);
