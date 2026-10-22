ALTER TABLE `employees` ADD `province` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `employees` ADD `ward` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `employees` ADD `address_line` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `employees` ADD `age` integer;
--> statement-breakpoint
ALTER TABLE `employees` ADD `cccd_image_key` text;
--> statement-breakpoint
ALTER TABLE `employees` ADD `cccd_image_name` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `scheduled_start_at` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `scheduled_end_at` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `previous_session_id` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `close_reason` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `close_status` text DEFAULT 'PENDING' NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_shift_sessions_employee_active` ON `shift_sessions` (`employee_id`,`status`,`scheduled_end_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shift_sessions_previous_session` ON `shift_sessions` (`previous_session_id`) WHERE `previous_session_id` IS NOT NULL;
