CREATE TABLE IF NOT EXISTS `cccd_deletion_outbox` (
	`key` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`reason` text NOT NULL,
	`attempts` integer NOT NULL DEFAULT 0,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cccd_deletion_outbox_created`
ON `cccd_deletion_outbox` (`created_at`,`key`);
