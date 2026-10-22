CREATE TABLE IF NOT EXISTS `cccd_upload_registry` (
	`key` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_store_id` text,
	`actor_global_access` integer NOT NULL DEFAULT 0,
	`original_name` text,
	`content_type` text NOT NULL,
	`created_at` text NOT NULL,
	`claim_status` text NOT NULL DEFAULT 'PENDING' CHECK (`claim_status` IN ('PENDING', 'CLAIMED')),
	`claimed_at` text,
	`claimed_employee_id` text,
	`deletion_status` text NOT NULL DEFAULT 'NONE' CHECK (`deletion_status` IN ('NONE', 'PENDING', 'DELETED')),
	`delete_requested_at` text,
	`deleted_at` text,
	`deletion_attempts` integer NOT NULL DEFAULT 0,
	`last_deletion_error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cccd_upload_registry_pending`
ON `cccd_upload_registry` (`claim_status`,`deletion_status`,`created_at`,`key`);
--> statement-breakpoint
CREATE INDEX `idx_cccd_upload_registry_employee`
ON `cccd_upload_registry` (`claimed_employee_id`,`deletion_status`,`key`);
