ALTER TABLE `users` ADD COLUMN `is_super_admin` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE `admin_reset_archives` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`filter_json` text NOT NULL,
	`summary_json` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_admin_reset_archives_store_created` ON `admin_reset_archives` (`store_id`,`created_at`);
