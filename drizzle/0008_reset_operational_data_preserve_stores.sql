CREATE TABLE IF NOT EXISTS `system_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
DELETE FROM `employee_payroll_closings`;
--> statement-breakpoint
DELETE FROM `orders`;
--> statement-breakpoint
DELETE FROM `shift_sessions`;
--> statement-breakpoint
DELETE FROM `employee_transfers`;
--> statement-breakpoint
DELETE FROM `business_records`;
--> statement-breakpoint
DELETE FROM `audit_logs`;
--> statement-breakpoint
DELETE FROM `sessions`
WHERE NOT EXISTS (
	SELECT 1
	FROM `users` AS `manager_user`
	WHERE `manager_user`.`id` = `sessions`.`user_id`
		AND `manager_user`.`role` = 'MANAGER'
);
--> statement-breakpoint
DELETE FROM `users` WHERE `role` != 'MANAGER';
--> statement-breakpoint
UPDATE `users`
SET `employee_id` = NULL,
	`store_id` = NULL,
	`failed_attempts` = 0,
	`locked_until` = NULL,
	`shift_active` = 0,
	`current_shift` = NULL,
	`shift_started_at` = NULL
WHERE `role` = 'MANAGER';
--> statement-breakpoint
DELETE FROM `employees`;
--> statement-breakpoint
UPDATE `stores`
SET `revenue` = 0,
	`expense` = 0;
--> statement-breakpoint
INSERT OR IGNORE INTO `system_state` (`key`, `value`, `updated_at`)
VALUES ('data_reset_2026_08_08_v2', 'R2_PENDING', CURRENT_TIMESTAMP);
