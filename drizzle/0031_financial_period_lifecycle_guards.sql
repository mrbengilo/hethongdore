-- Additive lifecycle hardening. This migration only installs guards; it does
-- not rewrite any historical business or financial-period row.

-- A canonical period is born as DRAFT and can only advance one state at a
-- time. Revision is part of the optimistic-lock/audit contract, so every
-- transition advances it exactly once.
CREATE TRIGGER IF NOT EXISTS `trg_financial_periods_initial_state`
BEFORE INSERT ON `financial_periods`
WHEN NEW.`status` != 'DRAFT' OR NEW.`revision` != 0
BEGIN
  SELECT RAISE(ABORT, 'financial period must start as DRAFT revision 0');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_financial_periods_adjacent_transition`
BEFORE UPDATE OF `status` ON `financial_periods`
WHEN OLD.`status` IS NOT NEW.`status` AND (
  NEW.`revision` != OLD.`revision` + 1
  OR NOT (
    (OLD.`status` = 'DRAFT' AND NEW.`status` = 'CALCULATED')
    OR (OLD.`status` = 'CALCULATED' AND NEW.`status` = 'RECONCILING')
    OR (OLD.`status` = 'RECONCILING' AND NEW.`status` = 'CONFIRMED')
    OR (OLD.`status` = 'CONFIRMED' AND NEW.`status` = 'PAID')
    OR (OLD.`status` = 'PAID' AND NEW.`status` = 'LOCKED')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid financial period lifecycle transition');
END;
--> statement-breakpoint

-- From CONFIRMED onward, every finance/config/payroll fact is immutable.
-- snapshot_json may advance only its lifecycle settlement metadata; the
-- canonical calculation payload is compared after removing exactly those
-- metadata paths. PAID metadata is immutable once PAID has been reached.
CREATE TRIGGER IF NOT EXISTS `trg_financial_periods_confirmed_snapshot_freeze`
BEFORE UPDATE ON `financial_periods`
WHEN OLD.`status` IN ('CONFIRMED', 'PAID', 'LOCKED') AND (
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`store_id` IS NOT OLD.`store_id`
  OR NEW.`period` IS NOT OLD.`period`
  OR NEW.`policy_version_id` IS NOT OLD.`policy_version_id`
  OR NEW.`config_version` IS NOT OLD.`config_version`
  OR NEW.`gross_revenue` IS NOT OLD.`gross_revenue`
  OR NEW.`fixed_expense` IS NOT OLD.`fixed_expense`
  OR NEW.`variable_expense` IS NOT OLD.`variable_expense`
  OR NEW.`inventory_cost` IS NOT OLD.`inventory_cost`
  OR NEW.`inventory_shipping_cost` IS NOT OLD.`inventory_shipping_cost`
  OR NEW.`employee_salary` IS NOT OLD.`employee_salary`
  OR NEW.`manager_salary` IS NOT OLD.`manager_salary`
  OR NEW.`manual_bonus` IS NOT OLD.`manual_bonus`
  OR NEW.`allowance` IS NOT OLD.`allowance`
  OR NEW.`total_hours_seconds` IS NOT OLD.`total_hours_seconds`
  OR NEW.`employee_kpi_total` IS NOT OLD.`employee_kpi_total`
  OR NEW.`manager_kpi` IS NOT OLD.`manager_kpi`
  OR NEW.`operating_profit` IS NOT OLD.`operating_profit`
  OR NEW.`profit_after_kpi` IS NOT OLD.`profit_after_kpi`
  OR NEW.`month_end_expense` IS NOT OLD.`month_end_expense`
  OR NEW.`final_profit` IS NOT OLD.`final_profit`
  OR NEW.`distributable_profit` IS NOT OLD.`distributable_profit`
  OR NEW.`salary_advance` IS NOT OLD.`salary_advance`
  OR NEW.`employee_payroll_rows_json` IS NOT OLD.`employee_payroll_rows_json`
  OR NEW.`manager_payroll_json` IS NOT OLD.`manager_payroll_json`
  OR NEW.`config_snapshot_json` IS NOT OLD.`config_snapshot_json`
  OR NEW.`calculated_at` IS NOT OLD.`calculated_at`
  OR NEW.`calculated_by` IS NOT OLD.`calculated_by`
  OR NEW.`confirmed_at` IS NOT OLD.`confirmed_at`
  OR NEW.`confirmed_by` IS NOT OLD.`confirmed_by`
  OR NEW.`created_at` IS NOT OLD.`created_at`
  OR (NEW.`status` = OLD.`status` AND NEW.`revision` IS NOT OLD.`revision`)
  OR (OLD.`status` IN ('PAID', 'LOCKED') AND (
    NEW.`paid_at` IS NOT OLD.`paid_at` OR NEW.`paid_by` IS NOT OLD.`paid_by`
  ))
  OR json_remove(
    NEW.`snapshot_json`, '$.status', '$.paidAt', '$.paidBy', '$.lockedAt', '$.lockedBy'
  ) IS NOT json_remove(
    OLD.`snapshot_json`, '$.status', '$.paidAt', '$.paidBy', '$.lockedAt', '$.lockedBy'
  )
  OR json_extract(NEW.`snapshot_json`, '$.status') IS NOT NEW.`status`
  OR json_extract(NEW.`snapshot_json`, '$.paidAt') IS NOT NEW.`paid_at`
  OR json_extract(NEW.`snapshot_json`, '$.paidBy') IS NOT NEW.`paid_by`
  OR json_extract(NEW.`snapshot_json`, '$.lockedAt') IS NOT NEW.`locked_at`
  OR json_extract(NEW.`snapshot_json`, '$.lockedBy') IS NOT NEW.`locked_by`
)
BEGIN
  SELECT RAISE(ABORT, 'CONFIRMED financial snapshot is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_financial_periods_confirmed_delete`
BEFORE DELETE ON `financial_periods`
WHEN OLD.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
BEGIN
  SELECT RAISE(ABORT, 'finalized financial period cannot be deleted');
END;
--> statement-breakpoint

-- Source rows stop accepting writes as soon as their canonical period is
-- CONFIRMED. UPDATE guards inspect both OLD and NEW attribution so a row
-- cannot be moved out of, or into, a finalized period to bypass the freeze.
CREATE TRIGGER IF NOT EXISTS `trg_month_end_expenses_finalized_insert`
BEFORE INSERT ON `month_end_expenses`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = NEW.`store_id` AND period.`period` = NEW.`period`
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept month-end expenses'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_month_end_expenses_finalized_update`
BEFORE UPDATE ON `month_end_expenses`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = OLD.`store_id` AND period.`period` = OLD.`period`
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
) OR EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = NEW.`store_id` AND period.`period` = NEW.`period`
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept month-end expense changes'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_month_end_expenses_finalized_delete`
BEFORE DELETE ON `month_end_expenses`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = OLD.`store_id` AND period.`period` = OLD.`period`
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept month-end expense changes'); END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trg_shift_sessions_finalized_insert`
BEFORE INSERT ON `shift_sessions`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = NEW.`store_id`
    AND period.`period` = COALESCE(
      CASE WHEN NEW.`work_date` GLOB '????-??-??' THEN substr(NEW.`work_date`, 1, 7) END,
      strftime('%Y-%m', NEW.`started_at`, '+7 hours')
    )
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept shift sessions'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_shift_sessions_finalized_update`
BEFORE UPDATE ON `shift_sessions`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = OLD.`store_id`
    AND period.`period` = COALESCE(
      CASE WHEN OLD.`work_date` GLOB '????-??-??' THEN substr(OLD.`work_date`, 1, 7) END,
      strftime('%Y-%m', OLD.`started_at`, '+7 hours')
    )
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
) OR EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = NEW.`store_id`
    AND period.`period` = COALESCE(
      CASE WHEN NEW.`work_date` GLOB '????-??-??' THEN substr(NEW.`work_date`, 1, 7) END,
      strftime('%Y-%m', NEW.`started_at`, '+7 hours')
    )
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept shift session changes'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_shift_sessions_finalized_delete`
BEFORE DELETE ON `shift_sessions`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = OLD.`store_id`
    AND period.`period` = COALESCE(
      CASE WHEN OLD.`work_date` GLOB '????-??-??' THEN substr(OLD.`work_date`, 1, 7) END,
      strftime('%Y-%m', OLD.`started_at`, '+7 hours')
    )
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept shift session changes'); END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trg_daily_shift_definitions_finalized_insert`
BEFORE INSERT ON `daily_shift_definitions`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = NEW.`store_id` AND period.`period` = substr(NEW.`work_date`, 1, 7)
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept daily shifts'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_daily_shift_definitions_finalized_update`
BEFORE UPDATE ON `daily_shift_definitions`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = OLD.`store_id` AND period.`period` = substr(OLD.`work_date`, 1, 7)
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
) OR EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = NEW.`store_id` AND period.`period` = substr(NEW.`work_date`, 1, 7)
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept daily shift changes'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_daily_shift_definitions_finalized_delete`
BEFORE DELETE ON `daily_shift_definitions`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = OLD.`store_id` AND period.`period` = substr(OLD.`work_date`, 1, 7)
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept daily shift changes'); END;
--> statement-breakpoint

-- Orders are attributed by Ho Chi Minh City calendar month. SQLite's +7 hour
-- modifier keeps the boundary deterministic for the system's canonical UTC
-- timestamps, including 17:00Z on the final UTC day of the prior month.
CREATE TRIGGER IF NOT EXISTS `trg_orders_finalized_insert`
BEFORE INSERT ON `orders`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = NEW.`store_id`
    AND period.`period` = strftime('%Y-%m', NEW.`created_at`, '+7 hours')
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept orders'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_orders_finalized_update`
BEFORE UPDATE ON `orders`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = OLD.`store_id`
    AND period.`period` = strftime('%Y-%m', OLD.`created_at`, '+7 hours')
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
) OR EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = NEW.`store_id`
    AND period.`period` = strftime('%Y-%m', NEW.`created_at`, '+7 hours')
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept order changes'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_orders_finalized_delete`
BEFORE DELETE ON `orders`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = OLD.`store_id`
    AND period.`period` = strftime('%Y-%m', OLD.`created_at`, '+7 hours')
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept order changes'); END;
--> statement-breakpoint

-- These legacy business-record categories are still finance input sources.
-- PAYROLL_CLOSING and KPI_SUMMARY are intentionally excluded: they are system
-- projections whose settlement/lock status may advance after CONFIRMED.
CREATE TRIGGER IF NOT EXISTS `trg_business_records_finalized_insert`
BEFORE INSERT ON `business_records`
WHEN NEW.`category` IN (
  'CHI_PHI_CO_DINH', 'DONG_TIEN', 'NHAP_HANG', 'LUONG_THUONG'
) AND EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = NEW.`store_id`
    AND period.`period` = CASE
      WHEN NEW.`category` = 'CHI_PHI_CO_DINH' THEN json_extract(NEW.`data_json`, '$.period')
      ELSE COALESCE(
        json_extract(NEW.`data_json`, '$.period'),
        substr(json_extract(NEW.`data_json`, '$.date'), 1, 7)
      )
    END
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept financial business records'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_business_records_finalized_update`
BEFORE UPDATE ON `business_records`
WHEN (
  OLD.`category` IN (
    'CHI_PHI_CO_DINH', 'DONG_TIEN', 'NHAP_HANG', 'LUONG_THUONG'
  ) AND EXISTS (
    SELECT 1 FROM `financial_periods` period
    WHERE period.`store_id` = OLD.`store_id`
      AND period.`period` = CASE
        WHEN OLD.`category` = 'CHI_PHI_CO_DINH' THEN json_extract(OLD.`data_json`, '$.period')
        ELSE COALESCE(
          json_extract(OLD.`data_json`, '$.period'),
          substr(json_extract(OLD.`data_json`, '$.date'), 1, 7)
        )
      END
      AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
  )
) OR (
  NEW.`category` IN (
    'CHI_PHI_CO_DINH', 'DONG_TIEN', 'NHAP_HANG', 'LUONG_THUONG'
  ) AND EXISTS (
    SELECT 1 FROM `financial_periods` period
    WHERE period.`store_id` = NEW.`store_id`
      AND period.`period` = CASE
        WHEN NEW.`category` = 'CHI_PHI_CO_DINH' THEN json_extract(NEW.`data_json`, '$.period')
        ELSE COALESCE(
          json_extract(NEW.`data_json`, '$.period'),
          substr(json_extract(NEW.`data_json`, '$.date'), 1, 7)
        )
      END
      AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
  )
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept financial business record changes'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_business_records_finalized_delete`
BEFORE DELETE ON `business_records`
WHEN OLD.`category` IN (
  'CHI_PHI_CO_DINH', 'DONG_TIEN', 'NHAP_HANG', 'LUONG_THUONG'
) AND EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = OLD.`store_id`
    AND period.`period` = CASE
      WHEN OLD.`category` = 'CHI_PHI_CO_DINH' THEN json_extract(OLD.`data_json`, '$.period')
      ELSE COALESCE(
        json_extract(OLD.`data_json`, '$.period'),
        substr(json_extract(OLD.`data_json`, '$.date'), 1, 7)
      )
    END
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept financial business record changes'); END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trg_salary_advances_finalized_insert`
BEFORE INSERT ON `salary_advances`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = NEW.`store_id` AND period.`period` = NEW.`period`
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept salary advances'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_salary_advances_finalized_update`
BEFORE UPDATE ON `salary_advances`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = OLD.`store_id` AND period.`period` = OLD.`period`
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
) OR EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = NEW.`store_id` AND period.`period` = NEW.`period`
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept salary advance changes'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_salary_advances_finalized_delete`
BEFORE DELETE ON `salary_advances`
WHEN EXISTS (
  SELECT 1 FROM `financial_periods` period
  WHERE period.`store_id` = OLD.`store_id` AND period.`period` = OLD.`period`
    AND period.`status` IN ('CONFIRMED', 'PAID', 'LOCKED')
)
BEGIN SELECT RAISE(ABORT, 'finalized financial period does not accept salary advance changes'); END;
