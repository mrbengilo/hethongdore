CREATE TRIGGER IF NOT EXISTS trg_payroll_review_validate_insert
    BEFORE INSERT ON business_records WHEN NEW.category = 'PAYROLL_REVIEW'
    AND (NEW.status IS NOT 'ACTIVE' OR NEW.store_id IS NULL
      OR json_valid(NEW.data_json) != 1 OR json_type(NEW.data_json, '$.values.durationSeconds') IS NOT 'integer'
    OR json_extract(NEW.data_json, '$.values.durationSeconds') NOT BETWEEN 0 AND 9007199254740991 OR json_type(NEW.data_json, '$.values.kpiDurationSeconds') IS NOT 'integer'
    OR json_extract(NEW.data_json, '$.values.kpiDurationSeconds') NOT BETWEEN 0 AND 9007199254740991 OR json_type(NEW.data_json, '$.values.tiktokAllowance') IS NOT 'integer'
    OR json_extract(NEW.data_json, '$.values.tiktokAllowance') NOT BETWEEN 0 AND 9007199254740991 OR json_type(NEW.data_json, '$.values.supportAllowance') IS NOT 'integer'
    OR json_extract(NEW.data_json, '$.values.supportAllowance') NOT BETWEEN 0 AND 9007199254740991 OR json_type(NEW.data_json, '$.values.manualAllowance') IS NOT 'integer'
    OR json_extract(NEW.data_json, '$.values.manualAllowance') NOT BETWEEN 0 AND 9007199254740991 OR json_type(NEW.data_json, '$.values.manualBonus') IS NOT 'integer'
    OR json_extract(NEW.data_json, '$.values.manualBonus') NOT BETWEEN 0 AND 9007199254740991
      OR json_extract(NEW.data_json, '$.values.durationSeconds') > 2678400
      OR json_extract(NEW.data_json, '$.values.kpiDurationSeconds') > json_extract(NEW.data_json, '$.values.durationSeconds')
      OR json_type(NEW.data_json, '$.values.kpiBonus') NOT IN ('null', 'integer')
      OR json_type(NEW.data_json, '$.values.kpiBonus') IS NULL
      OR (json_type(NEW.data_json, '$.values.kpiBonus') = 'integer' AND json_extract(NEW.data_json, '$.values.kpiBonus') NOT BETWEEN 0 AND 9007199254740991)
      OR json_type(NEW.data_json, '$.version') IS NOT 'integer' OR json_extract(NEW.data_json, '$.version') NOT BETWEEN 1 AND 9007199254740991
      OR json_type(NEW.data_json, '$.source') IS NOT 'object'
      OR json_type(NEW.data_json, '$.employeeId') IS NOT 'text'
      OR json_type(NEW.data_json, '$.period') IS NOT 'text'
      OR NEW.id IS NOT 'payroll-review:' || NEW.store_id || ':' || json_extract(NEW.data_json, '$.employeeId') || ':' || json_extract(NEW.data_json, '$.period'))
    BEGIN SELECT RAISE(ABORT, 'invalid payroll review'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_payroll_review_validate_update
    BEFORE UPDATE ON business_records WHEN NEW.category = 'PAYROLL_REVIEW'
    AND (NEW.status IS NOT 'ACTIVE' OR NEW.store_id IS NULL
      OR json_valid(NEW.data_json) != 1 OR json_type(NEW.data_json, '$.values.durationSeconds') IS NOT 'integer'
    OR json_extract(NEW.data_json, '$.values.durationSeconds') NOT BETWEEN 0 AND 9007199254740991 OR json_type(NEW.data_json, '$.values.kpiDurationSeconds') IS NOT 'integer'
    OR json_extract(NEW.data_json, '$.values.kpiDurationSeconds') NOT BETWEEN 0 AND 9007199254740991 OR json_type(NEW.data_json, '$.values.tiktokAllowance') IS NOT 'integer'
    OR json_extract(NEW.data_json, '$.values.tiktokAllowance') NOT BETWEEN 0 AND 9007199254740991 OR json_type(NEW.data_json, '$.values.supportAllowance') IS NOT 'integer'
    OR json_extract(NEW.data_json, '$.values.supportAllowance') NOT BETWEEN 0 AND 9007199254740991 OR json_type(NEW.data_json, '$.values.manualAllowance') IS NOT 'integer'
    OR json_extract(NEW.data_json, '$.values.manualAllowance') NOT BETWEEN 0 AND 9007199254740991 OR json_type(NEW.data_json, '$.values.manualBonus') IS NOT 'integer'
    OR json_extract(NEW.data_json, '$.values.manualBonus') NOT BETWEEN 0 AND 9007199254740991
      OR json_extract(NEW.data_json, '$.values.durationSeconds') > 2678400
      OR json_extract(NEW.data_json, '$.values.kpiDurationSeconds') > json_extract(NEW.data_json, '$.values.durationSeconds')
      OR json_type(NEW.data_json, '$.values.kpiBonus') NOT IN ('null', 'integer')
      OR json_type(NEW.data_json, '$.values.kpiBonus') IS NULL
      OR (json_type(NEW.data_json, '$.values.kpiBonus') = 'integer' AND json_extract(NEW.data_json, '$.values.kpiBonus') NOT BETWEEN 0 AND 9007199254740991)
      OR json_type(NEW.data_json, '$.version') IS NOT 'integer' OR json_extract(NEW.data_json, '$.version') NOT BETWEEN 1 AND 9007199254740991
      OR json_type(NEW.data_json, '$.source') IS NOT 'object'
      OR json_type(NEW.data_json, '$.employeeId') IS NOT 'text'
      OR json_type(NEW.data_json, '$.period') IS NOT 'text'
      OR NEW.id IS NOT 'payroll-review:' || NEW.store_id || ':' || json_extract(NEW.data_json, '$.employeeId') || ':' || json_extract(NEW.data_json, '$.period'))
    BEGIN SELECT RAISE(ABORT, 'invalid payroll review'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_payroll_review_identity BEFORE UPDATE ON business_records
    WHEN OLD.category = 'PAYROLL_REVIEW' AND (NEW.category IS NOT OLD.category OR NEW.id IS NOT OLD.id
      OR NEW.store_id IS NOT OLD.store_id
      OR json_extract(NEW.data_json, '$.version') IS NOT json_extract(OLD.data_json, '$.version') + 1)
    BEGIN SELECT RAISE(ABORT, 'payroll review identity or version changed'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_payroll_review_frozen_insert
    BEFORE INSERT ON business_records WHEN NEW.category = 'PAYROLL_REVIEW' AND (
      EXISTS (SELECT 1 FROM financial_periods WHERE store_id = NEW.store_id
        AND period = json_extract(NEW.data_json, '$.period') AND status IN ('CONFIRMED', 'PAID', 'LOCKED'))
      OR EXISTS (SELECT 1 FROM business_records gate WHERE gate.store_id = NEW.store_id
        AND json_extract(gate.data_json, '$.period') = json_extract(NEW.data_json, '$.period')
        AND ((gate.category = 'KPI_SUMMARY' AND gate.status IN ('CLOSING', 'LOCKED'))
          OR (gate.category = 'PAYROLL_CLOSING' AND gate.status IN ('REWARDS_CONFIRMED', 'PAYMENT_CONFIRMED', 'LOCKED'))))
      OR EXISTS (SELECT 1 FROM employee_payroll_closings gate WHERE gate.store_id = NEW.store_id
        AND gate.employee_id = json_extract(NEW.data_json, '$.employeeId')
        AND gate.period = json_extract(NEW.data_json, '$.period') AND gate.status = 'CLOSING'))
    BEGIN SELECT RAISE(ABORT, 'payroll review is frozen'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_payroll_review_frozen_update
    BEFORE UPDATE ON business_records WHEN NEW.category = 'PAYROLL_REVIEW' AND (
      EXISTS (SELECT 1 FROM financial_periods WHERE store_id = NEW.store_id
        AND period = json_extract(NEW.data_json, '$.period') AND status IN ('CONFIRMED', 'PAID', 'LOCKED'))
      OR EXISTS (SELECT 1 FROM business_records gate WHERE gate.store_id = NEW.store_id
        AND json_extract(gate.data_json, '$.period') = json_extract(NEW.data_json, '$.period')
        AND ((gate.category = 'KPI_SUMMARY' AND gate.status IN ('CLOSING', 'LOCKED'))
          OR (gate.category = 'PAYROLL_CLOSING' AND gate.status IN ('REWARDS_CONFIRMED', 'PAYMENT_CONFIRMED', 'LOCKED'))))
      OR EXISTS (SELECT 1 FROM employee_payroll_closings gate WHERE gate.store_id = NEW.store_id
        AND gate.employee_id = json_extract(NEW.data_json, '$.employeeId')
        AND gate.period = json_extract(NEW.data_json, '$.period') AND gate.status = 'CLOSING'))
    BEGIN SELECT RAISE(ABORT, 'payroll review is frozen'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_payroll_review_frozen_delete
    BEFORE DELETE ON business_records WHEN OLD.category = 'PAYROLL_REVIEW' AND (
      EXISTS (SELECT 1 FROM financial_periods WHERE store_id = OLD.store_id
        AND period = json_extract(OLD.data_json, '$.period') AND status IN ('CONFIRMED', 'PAID', 'LOCKED'))
      OR EXISTS (SELECT 1 FROM business_records gate WHERE gate.store_id = OLD.store_id
        AND json_extract(gate.data_json, '$.period') = json_extract(OLD.data_json, '$.period')
        AND ((gate.category = 'KPI_SUMMARY' AND gate.status IN ('CLOSING', 'LOCKED'))
          OR (gate.category = 'PAYROLL_CLOSING' AND gate.status IN ('REWARDS_CONFIRMED', 'PAYMENT_CONFIRMED', 'LOCKED'))))
      OR EXISTS (SELECT 1 FROM employee_payroll_closings gate WHERE gate.store_id = OLD.store_id
        AND gate.employee_id = json_extract(OLD.data_json, '$.employeeId')
        AND gate.period = json_extract(OLD.data_json, '$.period') AND gate.status = 'CLOSING'))
    BEGIN SELECT RAISE(ABORT, 'payroll review is frozen'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_payroll_review_snapshot_versions BEFORE UPDATE ON financial_periods
    WHEN NEW.status IN ('CALCULATED', 'RECONCILING', 'CONFIRMED') AND (
      (SELECT COUNT(*) FROM business_records WHERE category = 'PAYROLL_REVIEW' AND store_id = NEW.store_id
        AND status = 'ACTIVE' AND json_extract(data_json, '$.period') = NEW.period)
        != COALESCE(json_array_length(NEW.config_snapshot_json, '$.payrollSummary.reviewVersions'), 0)
      OR EXISTS (SELECT 1 FROM business_records saved WHERE saved.category = 'PAYROLL_REVIEW'
        AND saved.store_id = NEW.store_id AND saved.status = 'ACTIVE' AND json_extract(saved.data_json, '$.period') = NEW.period
        AND NOT EXISTS (SELECT 1 FROM json_each(NEW.config_snapshot_json, '$.payrollSummary.reviewVersions') expected
          WHERE json_extract(expected.value, '$.employeeId') = json_extract(saved.data_json, '$.employeeId')
            AND json_extract(expected.value, '$.version') = json_extract(saved.data_json, '$.version'))))
    BEGIN SELECT RAISE(ABORT, 'payroll review changed during confirmation'); END;
