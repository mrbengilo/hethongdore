ALTER TABLE `shift_sessions` ADD `tasks_completed` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `expense_amount` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `expense_note` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `cash_revenue` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `transfer_revenue` integer DEFAULT 0 NOT NULL;
