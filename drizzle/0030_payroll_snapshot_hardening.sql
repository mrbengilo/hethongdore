-- Snapshot transfer support allowance on every mutable attendance session.
-- This is a one-time compatibility capture for legacy rows: completed rows in
-- open periods must stop reading the mutable employee transfer configuration.
-- LOCKED periods are deliberately left untouched and continue to use their
-- immutable financial/payroll snapshots.
ALTER TABLE `shift_sessions` ADD COLUMN `applied_support_allowance` integer;
--> statement-breakpoint
UPDATE `shift_sessions`
SET `applied_support_allowance` = COALESCE((
  SELECT transfer.`support_allowance`
  FROM `employee_transfers` transfer
  WHERE transfer.`id` = `shift_sessions`.`transfer_id`
), 0)
WHERE `applied_support_allowance` IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `financial_periods` locked_period
    WHERE locked_period.`store_id` = `shift_sessions`.`store_id`
      AND locked_period.`period` = COALESCE(
        CASE WHEN `shift_sessions`.`work_date` GLOB '????-??-??'
          THEN substr(`shift_sessions`.`work_date`, 1, 7) END,
        strftime('%Y-%m', `shift_sessions`.`started_at`, '+7 hours')
      )
      AND locked_period.`status` = 'LOCKED'
  );
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_shift_sessions_support_allowance_insert`
BEFORE INSERT ON `shift_sessions`
WHEN NEW.`applied_support_allowance` IS NOT NULL AND (
  typeof(NEW.`applied_support_allowance`) != 'integer'
  OR NEW.`applied_support_allowance` < 0
)
BEGIN
  SELECT RAISE(ABORT, 'invalid applied support allowance');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_shift_sessions_support_allowance_update`
BEFORE UPDATE OF `applied_support_allowance` ON `shift_sessions`
WHEN NEW.`applied_support_allowance` IS NOT NULL AND (
  typeof(NEW.`applied_support_allowance`) != 'integer'
  OR NEW.`applied_support_allowance` < 0
)
BEGIN
  SELECT RAISE(ABORT, 'invalid applied support allowance');
END;
