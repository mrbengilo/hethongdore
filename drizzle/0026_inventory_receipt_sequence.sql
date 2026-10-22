CREATE TABLE IF NOT EXISTS `inventory_receipt_code_sequences` (
  `id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
  `last_value` integer NOT NULL CHECK (`last_value` >= 0),
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `inventory_receipt_requests` (
  `record_id` text PRIMARY KEY NOT NULL,
  `store_id` text NOT NULL,
  `actor_user_id` text NOT NULL,
  `client_request_id` text NOT NULL,
  `payload_hash` text NOT NULL,
  `receipt_date` text NOT NULL,
  `sequence_value` integer NOT NULL CHECK (`sequence_value` > 0),
  `receipt_no` text NOT NULL UNIQUE,
  `created_at` text NOT NULL,
  UNIQUE (`store_id`, `actor_user_id`, `client_request_id`),
  UNIQUE (`sequence_value`)
);
