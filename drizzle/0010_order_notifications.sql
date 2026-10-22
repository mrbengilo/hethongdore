ALTER TABLE `orders` ADD `client_request_id` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `client_request_fingerprint` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_orders_employee_client_request`
ON `orders` (`employee_id`, `client_request_id`)
WHERE `client_request_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient_user_id` text NOT NULL,
	`store_id` text NOT NULL,
	`type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`read_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notifications_recipient_type_entity`
ON `notifications` (`recipient_user_id`, `type`, `entity_id`);
--> statement-breakpoint
CREATE INDEX `idx_notifications_recipient_unread`
ON `notifications` (`recipient_user_id`, `read_at`, `created_at`);
