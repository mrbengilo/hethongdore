CREATE TABLE `stores` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL UNIQUE,
  `address` text NOT NULL,
  `revenue` integer DEFAULT 0 NOT NULL,
  `expense` integer DEFAULT 0 NOT NULL,
  `status` text DEFAULT 'ACTIVE' NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `employees` (
  `id` text PRIMARY KEY NOT NULL,
  `store_id` text NOT NULL,
  `code` text NOT NULL UNIQUE,
  `name` text NOT NULL,
  `position` text NOT NULL,
  `phone` text NOT NULL,
  `hourly_rate` integer DEFAULT 20000 NOT NULL,
  `status` text DEFAULT 'ACTIVE' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `username` text NOT NULL UNIQUE,
  `password_hash` text NOT NULL,
  `role` text NOT NULL,
  `name` text NOT NULL,
  `employee_id` text,
  `store_id` text,
  `failed_attempts` integer DEFAULT 0 NOT NULL,
  `locked_until` integer,
  `shift_active` integer DEFAULT 0 NOT NULL,
  `current_shift` text,
  `shift_started_at` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (`id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, `token_hash` text NOT NULL UNIQUE, `expires_at` integer NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `orders` (`id` text PRIMARY KEY NOT NULL, `code` text NOT NULL UNIQUE, `store_id` text NOT NULL, `employee_id` text NOT NULL, `shift_code` text NOT NULL, `customer_name` text, `phone` text, `age` integer, `amount` integer NOT NULL, `payment_method` text NOT NULL, `status` text DEFAULT 'COMPLETED' NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `audit_logs` (`id` text PRIMARY KEY NOT NULL, `user_id` text, `action` text NOT NULL, `entity_type` text NOT NULL, `entity_id` text, `detail` text, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `idx_orders_store_shift` ON `orders` (`store_id`,`employee_id`,`shift_code`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_token` ON `sessions` (`token_hash`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_employees_store` ON `employees` (`store_id`,`status`);

