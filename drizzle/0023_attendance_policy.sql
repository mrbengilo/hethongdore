ALTER TABLE `shift_sessions` ADD COLUMN `attendance_grace_minutes` integer DEFAULT 15 NOT NULL CHECK (`attendance_grace_minutes` BETWEEN 0 AND 120);
--> statement-breakpoint
INSERT OR IGNORE INTO `system_state` (`key`, `value`, `updated_at`)
VALUES (
  'attendance_late_grace_policy_v1',
  '{"schemaVersion":1,"lateGraceMinutes":15,"version":1,"updatedBy":null,"mutationToken":null}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
