ALTER TABLE `shift_sessions` ADD `admin_adjusted_duration_seconds` integer;
--> statement-breakpoint
CREATE INDEX `idx_orders_store_created` ON `orders` (`store_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_shift_sessions_store_work_date_started` ON `shift_sessions` (`store_id`,`work_date`,`started_at`,`id`);
