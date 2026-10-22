ALTER TABLE `employees` ADD `status_updated_at` text;
--> statement-breakpoint
ALTER TABLE `employees` ADD `lifecycle_version` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `employees` ADD `deleted_at` text;
--> statement-breakpoint
ALTER TABLE `employees` ADD `deleted_by` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `employee_status_history` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`store_id` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`effective_at` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_employees_store_lifecycle`
ON `employees` (`store_id`,`status`,`deleted_at`,`code`);
--> statement-breakpoint
CREATE INDEX `idx_employee_status_history_employee_effective`
ON `employee_status_history` (`employee_id`,`effective_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_employee_status_history_store_effective`
ON `employee_status_history` (`store_id`,`effective_at`,`id`);
