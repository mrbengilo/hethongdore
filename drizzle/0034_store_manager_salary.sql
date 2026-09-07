CREATE TRIGGER IF NOT EXISTS trg_store_manager_salary_validate_insert
    BEFORE INSERT ON business_records WHEN NEW.category = 'STORE_MANAGER_SALARY'
    AND (NEW.store_id IS NULL OR NEW.status != 'ACTIVE' OR json_valid(NEW.data_json) != 1
      OR json_type(NEW.data_json, '$.amount') IS NOT 'integer'
      OR json_extract(NEW.data_json, '$.amount') NOT BETWEEN 0 AND 9007199254740991
      OR json_type(NEW.data_json, '$.version') IS NOT 'integer'
      OR json_extract(NEW.data_json, '$.version') NOT BETWEEN 1 AND 9007199254740991
      OR json_type(NEW.data_json, '$.period') IS NOT 'text'
      OR json_extract(NEW.data_json, '$.period') NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
      OR NEW.id IS NOT 'store-manager-salary:' || NEW.store_id || ':' || json_extract(NEW.data_json, '$.period'))
    BEGIN SELECT RAISE(ABORT, 'invalid store manager salary'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_store_manager_salary_validate_update
    BEFORE UPDATE ON business_records WHEN NEW.category = 'STORE_MANAGER_SALARY'
    AND (NEW.store_id IS NULL OR NEW.status != 'ACTIVE' OR json_valid(NEW.data_json) != 1
      OR json_type(NEW.data_json, '$.amount') IS NOT 'integer'
      OR json_extract(NEW.data_json, '$.amount') NOT BETWEEN 0 AND 9007199254740991
      OR json_type(NEW.data_json, '$.version') IS NOT 'integer'
      OR json_extract(NEW.data_json, '$.version') NOT BETWEEN 1 AND 9007199254740991
      OR json_type(NEW.data_json, '$.period') IS NOT 'text'
      OR json_extract(NEW.data_json, '$.period') NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
      OR NEW.id IS NOT 'store-manager-salary:' || NEW.store_id || ':' || json_extract(NEW.data_json, '$.period'))
    BEGIN SELECT RAISE(ABORT, 'invalid store manager salary'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_store_manager_salary_identity BEFORE UPDATE ON business_records
    WHEN OLD.category = 'STORE_MANAGER_SALARY' AND (NEW.category IS NOT OLD.category OR NEW.id IS NOT OLD.id
      OR NEW.store_id IS NOT OLD.store_id OR json_extract(NEW.data_json, '$.period') IS NOT json_extract(OLD.data_json, '$.period'))
    BEGIN SELECT RAISE(ABORT, 'store manager salary identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_store_manager_salary_frozen_insert
      BEFORE INSERT ON business_records WHEN NEW.category = 'STORE_MANAGER_SALARY' AND (EXISTS (
  SELECT 1 FROM financial_periods period_row WHERE period_row.store_id = NEW.store_id
    AND period_row.period = json_extract(NEW.data_json, '$.period') AND period_row.status != 'DRAFT'
) OR EXISTS (
  SELECT 1 FROM business_records source WHERE source.store_id = NEW.store_id
    AND source.category IN ('KPI_SUMMARY', 'PAYROLL_CLOSING') AND source.status != 'DELETED'
    AND json_extract(source.data_json, '$.period') = json_extract(NEW.data_json, '$.period')
))
      BEGIN SELECT RAISE(ABORT, 'manager salary is frozen'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_store_manager_salary_frozen_update
      BEFORE UPDATE ON business_records WHEN NEW.category = 'STORE_MANAGER_SALARY' AND (EXISTS (
  SELECT 1 FROM financial_periods period_row WHERE period_row.store_id = NEW.store_id
    AND period_row.period = json_extract(NEW.data_json, '$.period') AND period_row.status != 'DRAFT'
) OR EXISTS (
  SELECT 1 FROM business_records source WHERE source.store_id = NEW.store_id
    AND source.category IN ('KPI_SUMMARY', 'PAYROLL_CLOSING') AND source.status != 'DELETED'
    AND json_extract(source.data_json, '$.period') = json_extract(NEW.data_json, '$.period')
))
      BEGIN SELECT RAISE(ABORT, 'manager salary is frozen'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_store_manager_salary_frozen_delete
      BEFORE DELETE ON business_records WHEN OLD.category = 'STORE_MANAGER_SALARY' AND (EXISTS (
  SELECT 1 FROM financial_periods period_row WHERE period_row.store_id = OLD.store_id
    AND period_row.period = json_extract(OLD.data_json, '$.period') AND period_row.status != 'DRAFT'
) OR EXISTS (
  SELECT 1 FROM business_records source WHERE source.store_id = OLD.store_id
    AND source.category IN ('KPI_SUMMARY', 'PAYROLL_CLOSING') AND source.status != 'DELETED'
    AND json_extract(source.data_json, '$.period') = json_extract(OLD.data_json, '$.period')
))
      BEGIN SELECT RAISE(ABORT, 'manager salary is frozen'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_store_manager_salary_calculation_version BEFORE UPDATE ON financial_periods
    WHEN NEW.status = 'CALCULATED'
      AND (json_type(NEW.config_snapshot_json, '$.payrollSummary.managerSalaryVersion') IS NOT NULL
        OR EXISTS (SELECT 1 FROM business_records WHERE id = 'store-manager-salary:' || NEW.store_id || ':' || NEW.period))
      AND json_extract(NEW.config_snapshot_json, '$.payrollSummary.managerSalaryVersion') IS NOT COALESCE(
        (SELECT json_extract(data_json, '$.version') FROM business_records
          WHERE id = 'store-manager-salary:' || NEW.store_id || ':' || NEW.period), 0)
    BEGIN SELECT RAISE(ABORT, 'manager salary changed during calculation'); END;
