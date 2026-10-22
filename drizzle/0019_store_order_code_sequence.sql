CREATE TABLE IF NOT EXISTS `store_order_code_sequences` (
	`store_id` text PRIMARY KEY NOT NULL,
	`code_prefix` text NOT NULL,
	`last_value` integer NOT NULL CHECK (`last_value` >= 0),
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_store_order_code_sequences_prefix`
ON `store_order_code_sequences` (`code_prefix`);
