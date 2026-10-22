CREATE TABLE IF NOT EXISTS `salary_advances` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`period` text NOT NULL CHECK (`period` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
	`advance_date` text NOT NULL CHECK (`advance_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	`amount` integer NOT NULL CHECK (`amount` > 0),
	`gross_entitlement_snapshot` integer NOT NULL CHECK (`gross_entitlement_snapshot` >= 0),
	`available_before_snapshot` integer NOT NULL CHECK (`available_before_snapshot` >= 0),
	`remaining_after_snapshot` integer NOT NULL CHECK (`remaining_after_snapshot` >= 0),
	`note` text NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL CHECK (`status` IN ('DRAFT', 'PAID')),
	`version` integer DEFAULT 1 NOT NULL CHECK (`version` >= 1),
	`client_request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`mutation_token` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`paid_by` text,
	`paid_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_salary_advances_actor_request`
ON `salary_advances` (`store_id`,`created_by`,`client_request_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_salary_advances_store_period_employee`
ON `salary_advances` (`store_id`,`period`,`employee_id`,`status`);
