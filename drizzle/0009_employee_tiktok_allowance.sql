ALTER TABLE `employees` ADD `tiktok_allowance` integer DEFAULT 25000 NOT NULL;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `applied_tiktok_allowance` integer;
--> statement-breakpoint
UPDATE `shift_sessions` SET `applied_tiktok_allowance` = 25000
WHERE `status` = 'ACTIVE' AND `applied_tiktok_allowance` IS NULL;
