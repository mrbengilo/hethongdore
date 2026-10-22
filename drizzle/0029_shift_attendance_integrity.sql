-- Additive attendance provenance and policy snapshots. Existing rows are not
-- rewritten: NULL means the row predates the corresponding snapshot.
ALTER TABLE `shift_sessions` ADD COLUMN `source_schedule_record_id` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD COLUMN `source_schedule_updated_at` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD COLUMN `attendance_early_window_minutes` integer;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD COLUMN `attendance_max_shift_minutes` integer;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD COLUMN `reconciliation_status` text NOT NULL DEFAULT 'CLEAR';
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD COLUMN `reconciliation_reason` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD COLUMN `reconciled_at` text;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD COLUMN `reconciled_by` text;
--> statement-breakpoint

-- Deliberately non-unique. A partial UNIQUE index would abort deployment when
-- a production database contains a pre-existing duplicate ACTIVE anomaly.
-- The triggers below preserve those rows and stop every new duplicate write.
CREATE INDEX IF NOT EXISTS `idx_shift_sessions_employee_status_integrity`
  ON `shift_sessions` (`employee_id`, `status`, `id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_shift_sessions_one_active_insert`
BEFORE INSERT ON `shift_sessions`
WHEN NEW.`status` = 'ACTIVE' AND EXISTS (
  SELECT 1 FROM `shift_sessions` existing
  WHERE existing.`employee_id` = NEW.`employee_id` AND existing.`status` = 'ACTIVE'
)
BEGIN
  SELECT RAISE(ABORT, 'employee already has an ACTIVE shift session');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_shift_sessions_one_active_update`
BEFORE UPDATE ON `shift_sessions`
WHEN NEW.`status` = 'ACTIVE' AND EXISTS (
  SELECT 1 FROM `shift_sessions` existing
  WHERE existing.`employee_id` = NEW.`employee_id`
    AND existing.`status` = 'ACTIVE' AND existing.`id` != OLD.`id`
)
BEGIN
  SELECT RAISE(ABORT, 'employee already has an ACTIVE shift session');
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trg_shift_sessions_validate_insert_v2`
BEFORE INSERT ON `shift_sessions`
WHEN NEW.`status` NOT IN ('ACTIVE', 'COMPLETED')
  OR julianday(NEW.`started_at`) IS NULL
  OR (NEW.`work_date` IS NOT NULL AND (
    NEW.`work_date` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR date(NEW.`work_date`) IS NOT NEW.`work_date`
  ))
  OR (NEW.`scheduled_start_at` IS NULL) != (NEW.`scheduled_end_at` IS NULL)
  OR (NEW.`scheduled_start_at` IS NOT NULL AND (
    julianday(NEW.`scheduled_start_at`) IS NULL
    OR julianday(NEW.`scheduled_end_at`) IS NULL
    OR julianday(NEW.`scheduled_end_at`) <= julianday(NEW.`scheduled_start_at`)
  ))
  OR (NEW.`source_schedule_record_id` IS NULL) != (NEW.`source_schedule_updated_at` IS NULL)
  OR (NEW.`source_schedule_record_id` IS NOT NULL AND (
    length(trim(NEW.`source_schedule_record_id`)) = 0
    OR julianday(NEW.`source_schedule_updated_at`) IS NULL
  ))
  OR typeof(NEW.`attendance_grace_minutes`) != 'integer'
  OR NEW.`attendance_grace_minutes` NOT BETWEEN 0 AND 120
  OR (NEW.`attendance_early_window_minutes` IS NOT NULL
    AND (typeof(NEW.`attendance_early_window_minutes`) != 'integer'
      OR NEW.`attendance_early_window_minutes` NOT BETWEEN 0 AND 1440))
  OR (NEW.`attendance_max_shift_minutes` IS NOT NULL
    AND (typeof(NEW.`attendance_max_shift_minutes`) != 'integer'
      OR NEW.`attendance_max_shift_minutes` NOT BETWEEN 1 AND 10080))
  OR NEW.`attendance_status` NOT IN ('EARLY', 'ON_TIME', 'LATE')
  OR (NEW.`attendance_status` IS NULL) != (NEW.`attendance_delta_minutes` IS NULL)
  OR (NEW.`attendance_delta_minutes` IS NOT NULL
    AND typeof(NEW.`attendance_delta_minutes`) != 'integer')
  OR (NEW.`applied_hourly_rate` IS NOT NULL
    AND (typeof(NEW.`applied_hourly_rate`) != 'integer' OR NEW.`applied_hourly_rate` < 0))
  OR (NEW.`applied_tiktok_allowance` IS NOT NULL
    AND (typeof(NEW.`applied_tiktok_allowance`) != 'integer' OR NEW.`applied_tiktok_allowance` < 0))
  OR typeof(NEW.`duration_seconds`) != 'integer' OR NEW.`duration_seconds` < 0
  OR (NEW.`admin_adjusted_duration_seconds` IS NOT NULL AND (
    typeof(NEW.`admin_adjusted_duration_seconds`) != 'integer'
    OR NEW.`admin_adjusted_duration_seconds` < 0
  ))
  OR NEW.`tiktok` NOT IN (0, 1) OR NEW.`tasks_completed` NOT IN (0, 1)
  OR typeof(NEW.`tiktok_allowance`) != 'integer' OR NEW.`tiktok_allowance` < 0
  OR typeof(NEW.`expense_amount`) != 'integer' OR NEW.`expense_amount` < 0
  OR typeof(NEW.`cash_revenue`) != 'integer' OR NEW.`cash_revenue` < 0
  OR typeof(NEW.`transfer_revenue`) != 'integer' OR NEW.`transfer_revenue` < 0
  OR NOT (
    (NEW.`clock_in_latitude` IS NULL AND NEW.`clock_in_longitude` IS NULL
      AND NEW.`clock_in_accuracy_meters` IS NULL AND NEW.`clock_in_location_captured_at` IS NULL)
    OR (NEW.`clock_in_latitude` IS NOT NULL AND NEW.`clock_in_latitude` BETWEEN -90 AND 90
      AND typeof(NEW.`clock_in_latitude`) IN ('integer', 'real')
      AND NEW.`clock_in_longitude` IS NOT NULL AND NEW.`clock_in_longitude` BETWEEN -180 AND 180
      AND typeof(NEW.`clock_in_longitude`) IN ('integer', 'real')
      AND NEW.`clock_in_accuracy_meters` IS NOT NULL AND NEW.`clock_in_accuracy_meters` BETWEEN 0 AND 100000
      AND typeof(NEW.`clock_in_accuracy_meters`) IN ('integer', 'real')
      AND julianday(NEW.`clock_in_location_captured_at`) IS NOT NULL)
  )
  OR NOT (
    (NEW.`reconciliation_status` = 'CLEAR' AND NEW.`reconciliation_reason` IS NULL
      AND NEW.`reconciled_at` IS NULL AND NEW.`reconciled_by` IS NULL)
    OR (NEW.`reconciliation_status` = 'REQUIRED'
      AND length(trim(COALESCE(NEW.`reconciliation_reason`, ''))) > 0
      AND NEW.`reconciled_at` IS NULL AND NEW.`reconciled_by` IS NULL)
    OR (NEW.`reconciliation_status` = 'CONFIRMED'
      AND length(trim(COALESCE(NEW.`reconciliation_reason`, ''))) > 0
      AND julianday(NEW.`reconciled_at`) IS NOT NULL
      AND length(trim(COALESCE(NEW.`reconciled_by`, ''))) > 0)
  )
  OR (NEW.`status` = 'ACTIVE' AND (
    NEW.`ended_at` IS NOT NULL OR NEW.`duration_seconds` != 0
    OR NEW.`admin_adjusted_duration_seconds` IS NOT NULL
    OR NEW.`reconciliation_status` != 'CLEAR'
  ))
  OR (NEW.`ended_at` IS NOT NULL AND (
    NEW.`status` != 'COMPLETED' OR julianday(NEW.`ended_at`) IS NULL
    OR julianday(NEW.`ended_at`) < julianday(NEW.`started_at`)
  ))
  OR (NEW.`status` = 'COMPLETED' AND NEW.`ended_at` IS NULL AND (
    NEW.`source_schedule_record_id` IS NOT NULL OR NEW.`source_schedule_updated_at` IS NOT NULL
    OR NEW.`attendance_early_window_minutes` IS NOT NULL OR NEW.`attendance_max_shift_minutes` IS NOT NULL
    OR NEW.`reconciliation_status` != 'CLEAR' OR NEW.`duration_seconds` != 0
    OR NEW.`admin_adjusted_duration_seconds` IS NOT NULL
    OR NEW.`tiktok` != 0 OR NEW.`tiktok_allowance` != 0 OR NEW.`tasks_completed` != 0
    OR NEW.`expense_amount` != 0 OR NEW.`cash_revenue` != 0 OR NEW.`transfer_revenue` != 0
  ))
  OR (NEW.`status` = 'COMPLETED' AND NEW.`ended_at` IS NOT NULL
    AND (NEW.`source_schedule_record_id` IS NOT NULL
      OR NEW.`source_schedule_updated_at` IS NOT NULL
      OR NEW.`attendance_early_window_minutes` IS NOT NULL
      OR NEW.`attendance_max_shift_minutes` IS NOT NULL)
    AND NEW.`admin_adjusted_duration_seconds` IS NULL
    AND ABS(NEW.`duration_seconds` - CAST(ROUND(
      (julianday(NEW.`ended_at`) - julianday(NEW.`started_at`)) * 86400
    ) AS INTEGER)) > 1)
  OR (NEW.`attendance_max_shift_minutes` IS NOT NULL
    AND COALESCE(NEW.`admin_adjusted_duration_seconds`, NEW.`duration_seconds`)
      > NEW.`attendance_max_shift_minutes` * 60
    AND NEW.`reconciliation_status` = 'CLEAR')
BEGIN
  SELECT RAISE(ABORT, 'invalid shift session integrity');
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trg_shift_sessions_validate_update_v2`
BEFORE UPDATE ON `shift_sessions`
WHEN NEW.`status` NOT IN ('ACTIVE', 'COMPLETED')
  OR julianday(NEW.`started_at`) IS NULL
  OR (NEW.`work_date` IS NOT NULL AND (
    NEW.`work_date` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR date(NEW.`work_date`) IS NOT NEW.`work_date`
  ))
  OR (NEW.`scheduled_start_at` IS NULL) != (NEW.`scheduled_end_at` IS NULL)
  OR (NEW.`scheduled_start_at` IS NOT NULL AND (
    julianday(NEW.`scheduled_start_at`) IS NULL
    OR julianday(NEW.`scheduled_end_at`) IS NULL
    OR julianday(NEW.`scheduled_end_at`) <= julianday(NEW.`scheduled_start_at`)
  ))
  OR (NEW.`source_schedule_record_id` IS NULL) != (NEW.`source_schedule_updated_at` IS NULL)
  OR (NEW.`source_schedule_record_id` IS NOT NULL AND (
    length(trim(NEW.`source_schedule_record_id`)) = 0
    OR julianday(NEW.`source_schedule_updated_at`) IS NULL
  ))
  OR typeof(NEW.`attendance_grace_minutes`) != 'integer'
  OR NEW.`attendance_grace_minutes` NOT BETWEEN 0 AND 120
  OR (NEW.`attendance_early_window_minutes` IS NOT NULL
    AND (typeof(NEW.`attendance_early_window_minutes`) != 'integer'
      OR NEW.`attendance_early_window_minutes` NOT BETWEEN 0 AND 1440))
  OR (NEW.`attendance_max_shift_minutes` IS NOT NULL
    AND (typeof(NEW.`attendance_max_shift_minutes`) != 'integer'
      OR NEW.`attendance_max_shift_minutes` NOT BETWEEN 1 AND 10080))
  OR NEW.`attendance_status` NOT IN ('EARLY', 'ON_TIME', 'LATE')
  OR (NEW.`attendance_status` IS NULL) != (NEW.`attendance_delta_minutes` IS NULL)
  OR (NEW.`attendance_delta_minutes` IS NOT NULL
    AND typeof(NEW.`attendance_delta_minutes`) != 'integer')
  OR (NEW.`applied_hourly_rate` IS NOT NULL
    AND (typeof(NEW.`applied_hourly_rate`) != 'integer' OR NEW.`applied_hourly_rate` < 0))
  OR (NEW.`applied_tiktok_allowance` IS NOT NULL
    AND (typeof(NEW.`applied_tiktok_allowance`) != 'integer' OR NEW.`applied_tiktok_allowance` < 0))
  OR typeof(NEW.`duration_seconds`) != 'integer' OR NEW.`duration_seconds` < 0
  OR (NEW.`admin_adjusted_duration_seconds` IS NOT NULL AND (
    typeof(NEW.`admin_adjusted_duration_seconds`) != 'integer'
    OR NEW.`admin_adjusted_duration_seconds` < 0
  ))
  OR NEW.`tiktok` NOT IN (0, 1) OR NEW.`tasks_completed` NOT IN (0, 1)
  OR typeof(NEW.`tiktok_allowance`) != 'integer' OR NEW.`tiktok_allowance` < 0
  OR typeof(NEW.`expense_amount`) != 'integer' OR NEW.`expense_amount` < 0
  OR typeof(NEW.`cash_revenue`) != 'integer' OR NEW.`cash_revenue` < 0
  OR typeof(NEW.`transfer_revenue`) != 'integer' OR NEW.`transfer_revenue` < 0
  OR NOT (
    (NEW.`clock_in_latitude` IS NULL AND NEW.`clock_in_longitude` IS NULL
      AND NEW.`clock_in_accuracy_meters` IS NULL AND NEW.`clock_in_location_captured_at` IS NULL)
    OR (NEW.`clock_in_latitude` IS NOT NULL AND NEW.`clock_in_latitude` BETWEEN -90 AND 90
      AND typeof(NEW.`clock_in_latitude`) IN ('integer', 'real')
      AND NEW.`clock_in_longitude` IS NOT NULL AND NEW.`clock_in_longitude` BETWEEN -180 AND 180
      AND typeof(NEW.`clock_in_longitude`) IN ('integer', 'real')
      AND NEW.`clock_in_accuracy_meters` IS NOT NULL AND NEW.`clock_in_accuracy_meters` BETWEEN 0 AND 100000
      AND typeof(NEW.`clock_in_accuracy_meters`) IN ('integer', 'real')
      AND julianday(NEW.`clock_in_location_captured_at`) IS NOT NULL)
  )
  OR NOT (
    (NEW.`reconciliation_status` = 'CLEAR' AND NEW.`reconciliation_reason` IS NULL
      AND NEW.`reconciled_at` IS NULL AND NEW.`reconciled_by` IS NULL)
    OR (NEW.`reconciliation_status` = 'REQUIRED'
      AND length(trim(COALESCE(NEW.`reconciliation_reason`, ''))) > 0
      AND NEW.`reconciled_at` IS NULL AND NEW.`reconciled_by` IS NULL)
    OR (NEW.`reconciliation_status` = 'CONFIRMED'
      AND length(trim(COALESCE(NEW.`reconciliation_reason`, ''))) > 0
      AND julianday(NEW.`reconciled_at`) IS NOT NULL
      AND length(trim(COALESCE(NEW.`reconciled_by`, ''))) > 0)
  )
  OR (NEW.`status` = 'ACTIVE' AND (
    NEW.`ended_at` IS NOT NULL OR NEW.`duration_seconds` != 0
    OR NEW.`admin_adjusted_duration_seconds` IS NOT NULL
    OR NEW.`reconciliation_status` != 'CLEAR'
  ))
  OR (NEW.`ended_at` IS NOT NULL AND (
    NEW.`status` != 'COMPLETED' OR julianday(NEW.`ended_at`) IS NULL
    OR julianday(NEW.`ended_at`) < julianday(NEW.`started_at`)
  ))
  OR (NEW.`status` = 'COMPLETED' AND NEW.`ended_at` IS NULL AND (
    OLD.`status` != 'COMPLETED'
    OR NEW.`source_schedule_record_id` IS NOT NULL OR NEW.`source_schedule_updated_at` IS NOT NULL
    OR NEW.`attendance_early_window_minutes` IS NOT NULL OR NEW.`attendance_max_shift_minutes` IS NOT NULL
    OR NEW.`reconciliation_status` != 'CLEAR' OR NEW.`duration_seconds` != 0
    OR NEW.`admin_adjusted_duration_seconds` IS NOT NULL
    OR NEW.`tiktok` != 0 OR NEW.`tiktok_allowance` != 0 OR NEW.`tasks_completed` != 0
    OR NEW.`expense_amount` != 0 OR NEW.`cash_revenue` != 0 OR NEW.`transfer_revenue` != 0
  ))
  OR (NEW.`status` = 'COMPLETED' AND NEW.`ended_at` IS NOT NULL
    AND (OLD.`status` != 'COMPLETED'
      OR NEW.`source_schedule_record_id` IS NOT NULL
      OR NEW.`source_schedule_updated_at` IS NOT NULL
      OR NEW.`attendance_early_window_minutes` IS NOT NULL
      OR NEW.`attendance_max_shift_minutes` IS NOT NULL)
    AND NEW.`admin_adjusted_duration_seconds` IS NULL
    AND ABS(NEW.`duration_seconds` - CAST(ROUND(
      (julianday(NEW.`ended_at`) - julianday(NEW.`started_at`)) * 86400
    ) AS INTEGER)) > 1)
  OR (NEW.`attendance_max_shift_minutes` IS NOT NULL
    AND COALESCE(NEW.`admin_adjusted_duration_seconds`, NEW.`duration_seconds`)
      > NEW.`attendance_max_shift_minutes` * 60
    AND NEW.`reconciliation_status` = 'CLEAR')
BEGIN
  SELECT RAISE(ABORT, 'invalid shift session integrity');
END;
--> statement-breakpoint

-- Canonical financial-period guards. Only LOCKED blocks source mutation;
-- DRAFT/CALCULATED/RECONCILING/CONFIRMED/PAID remain available to their
-- application workflows until the irreversible serialization point.
CREATE TRIGGER IF NOT EXISTS `trg_shift_sessions_locked_insert`
BEFORE INSERT ON `shift_sessions`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` locked_period
  WHERE locked_period.`store_id` = NEW.`store_id`
    AND locked_period.`period` = COALESCE(
      CASE WHEN NEW.`work_date` GLOB '????-??-??' THEN substr(NEW.`work_date`, 1, 7) END,
      strftime('%Y-%m', NEW.`started_at`, '+7 hours')
    )
    AND locked_period.`status` = 'LOCKED'
)
BEGIN
  SELECT RAISE(ABORT, 'LOCKED financial period does not accept shift sessions');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_shift_sessions_locked_update`
BEFORE UPDATE ON `shift_sessions`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` locked_period
  WHERE locked_period.`store_id` = OLD.`store_id`
    AND locked_period.`period` = COALESCE(
      CASE WHEN OLD.`work_date` GLOB '????-??-??' THEN substr(OLD.`work_date`, 1, 7) END,
      strftime('%Y-%m', OLD.`started_at`, '+7 hours')
    )
    AND locked_period.`status` = 'LOCKED'
) OR EXISTS (
  SELECT 1 FROM `financial_periods` locked_period
  WHERE locked_period.`store_id` = NEW.`store_id`
    AND locked_period.`period` = COALESCE(
      CASE WHEN NEW.`work_date` GLOB '????-??-??' THEN substr(NEW.`work_date`, 1, 7) END,
      strftime('%Y-%m', NEW.`started_at`, '+7 hours')
    )
    AND locked_period.`status` = 'LOCKED'
)
BEGIN
  SELECT RAISE(ABORT, 'LOCKED financial period does not accept shift session changes');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_shift_sessions_locked_delete`
BEFORE DELETE ON `shift_sessions`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` locked_period
  WHERE locked_period.`store_id` = OLD.`store_id`
    AND locked_period.`period` = COALESCE(
      CASE WHEN OLD.`work_date` GLOB '????-??-??' THEN substr(OLD.`work_date`, 1, 7) END,
      strftime('%Y-%m', OLD.`started_at`, '+7 hours')
    )
    AND locked_period.`status` = 'LOCKED'
)
BEGIN
  SELECT RAISE(ABORT, 'LOCKED financial period does not accept shift session changes');
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trg_daily_shift_definitions_validate_insert_v2`
BEFORE INSERT ON `daily_shift_definitions`
WHEN NEW.`status` NOT IN ('ACTIVE', 'DELETED') OR NEW.`version` < 1
  OR NEW.`work_date` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR date(NEW.`work_date`) IS NOT NEW.`work_date`
  OR NEW.`start_time` NOT GLOB '[0-2][0-9]:[0-5][0-9]'
  OR NEW.`end_time` NOT GLOB '[0-2][0-9]:[0-5][0-9]'
  OR substr(NEW.`start_time`, 1, 2) NOT BETWEEN '00' AND '23'
  OR substr(NEW.`end_time`, 1, 2) NOT BETWEEN '00' AND '23'
  OR substr(NEW.`start_time`, 4, 2) NOT BETWEEN '00' AND '59'
  OR substr(NEW.`end_time`, 4, 2) NOT BETWEEN '00' AND '59'
  OR NEW.`start_time` = NEW.`end_time`
  OR length(trim(NEW.`name`)) = 0 OR length(trim(NEW.`name_key`)) = 0
  OR (NEW.`status` = 'ACTIVE' AND NEW.`deleted_at` IS NOT NULL)
  OR (NEW.`status` = 'DELETED' AND NEW.`deleted_at` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid daily shift definition integrity');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_daily_shift_definitions_validate_update_v2`
BEFORE UPDATE ON `daily_shift_definitions`
WHEN NEW.`status` NOT IN ('ACTIVE', 'DELETED') OR NEW.`version` < 1
  OR NEW.`work_date` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR date(NEW.`work_date`) IS NOT NEW.`work_date`
  OR NEW.`start_time` NOT GLOB '[0-2][0-9]:[0-5][0-9]'
  OR NEW.`end_time` NOT GLOB '[0-2][0-9]:[0-5][0-9]'
  OR substr(NEW.`start_time`, 1, 2) NOT BETWEEN '00' AND '23'
  OR substr(NEW.`end_time`, 1, 2) NOT BETWEEN '00' AND '23'
  OR substr(NEW.`start_time`, 4, 2) NOT BETWEEN '00' AND '59'
  OR substr(NEW.`end_time`, 4, 2) NOT BETWEEN '00' AND '59'
  OR NEW.`start_time` = NEW.`end_time`
  OR length(trim(NEW.`name`)) = 0 OR length(trim(NEW.`name_key`)) = 0
  OR (NEW.`status` = 'ACTIVE' AND NEW.`deleted_at` IS NOT NULL)
  OR (NEW.`status` = 'DELETED' AND NEW.`deleted_at` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid daily shift definition integrity');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_daily_shift_definitions_locked_insert`
BEFORE INSERT ON `daily_shift_definitions`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` locked_period
  WHERE locked_period.`store_id` = NEW.`store_id`
    AND locked_period.`period` = substr(NEW.`work_date`, 1, 7)
    AND locked_period.`status` = 'LOCKED'
)
BEGIN
  SELECT RAISE(ABORT, 'LOCKED financial period does not accept daily shifts');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_daily_shift_definitions_locked_update`
BEFORE UPDATE ON `daily_shift_definitions`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` locked_period
  WHERE locked_period.`store_id` = OLD.`store_id`
    AND locked_period.`period` = substr(OLD.`work_date`, 1, 7)
    AND locked_period.`status` = 'LOCKED'
) OR EXISTS (
  SELECT 1 FROM `financial_periods` locked_period
  WHERE locked_period.`store_id` = NEW.`store_id`
    AND locked_period.`period` = substr(NEW.`work_date`, 1, 7)
    AND locked_period.`status` = 'LOCKED'
)
BEGIN
  SELECT RAISE(ABORT, 'LOCKED financial period does not accept daily shift changes');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_daily_shift_definitions_locked_delete`
BEFORE DELETE ON `daily_shift_definitions`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` locked_period
  WHERE locked_period.`store_id` = OLD.`store_id`
    AND locked_period.`period` = substr(OLD.`work_date`, 1, 7)
    AND locked_period.`status` = 'LOCKED'
)
BEGIN
  SELECT RAISE(ABORT, 'LOCKED financial period does not accept daily shift changes');
END;
