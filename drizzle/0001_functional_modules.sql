CREATE TABLE `business_records` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`store_id` text,
	`owner_id` text,
	`title` text NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_records_category_store` ON `business_records` (`category`,`store_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `shift_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`shift_code` text NOT NULL UNIQUE,
	`store_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`tiktok` integer DEFAULT 0 NOT NULL,
	`tiktok_allowance` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_shift_sessions_employee` ON `shift_sessions` (`employee_id`,`started_at`);
