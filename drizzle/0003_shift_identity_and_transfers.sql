ALTER TABLE `shift_sessions` ADD `shift_name` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `scheduled_start` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `scheduled_end` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `work_date` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `transfer_id` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `applied_hourly_rate` integer;
--> statement-breakpoint
CREATE TABLE `employee_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`source_store_id` text NOT NULL,
	`target_store_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`shifts_json` text DEFAULT '[]' NOT NULL,
	`support_hourly_rate` integer NOT NULL,
	`support_allowance` integer DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'SCHEDULED' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_shift_sessions_store_work_date` ON `shift_sessions` (`store_id`,`work_date`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_employee_transfers_employee_dates` ON `employee_transfers` (`employee_id`,`start_date`,`end_date`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_employee_transfers_target_dates` ON `employee_transfers` (`target_store_id`,`start_date`,`end_date`,`status`);
