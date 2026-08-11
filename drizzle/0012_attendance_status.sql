ALTER TABLE `shift_sessions` ADD `attendance_status` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `attendance_delta_minutes` integer;
--> statement-breakpoint
UPDATE `shift_sessions` SET
  `attendance_delta_minutes` = CAST(ROUND((julianday(`started_at`) - julianday(`scheduled_start_at`)) * 1440) AS INTEGER),
  `attendance_status` = CASE
    WHEN julianday(`started_at`) < julianday(`scheduled_start_at`) THEN 'EARLY'
    WHEN julianday(`started_at`) <= julianday(`scheduled_start_at`) THEN 'ON_TIME'
    ELSE 'LATE'
  END
WHERE `scheduled_start_at` IS NOT NULL
  AND (`attendance_status` IS NULL OR `attendance_delta_minutes` IS NULL);
--> statement-breakpoint
CREATE INDEX `idx_shift_sessions_store_attendance` ON `shift_sessions` (`store_id`,`work_date`,`attendance_status`);
