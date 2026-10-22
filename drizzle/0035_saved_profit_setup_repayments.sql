CREATE TABLE IF NOT EXISTS profit_setup_repayments (
    store_id TEXT NOT NULL REFERENCES stores(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(period, 6, 2) BETWEEN '01' AND '12'),
    amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount BETWEEN 0 AND 9007199254740991),
    version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991),
    updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) > 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (period, store_id)
  );
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_profit_setup_repayments_writable_insert
    BEFORE INSERT ON profit_setup_repayments
    BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM profit_distributions WHERE period = NEW.period)
        THEN RAISE(ABORT, 'setup repayment period is closed') END;
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM financial_periods
        WHERE store_id = NEW.store_id AND period = NEW.period AND status = 'LOCKED')
        THEN RAISE(ABORT, 'setup repayment store is not locked') END;
      SELECT CASE WHEN (SELECT final_profit - NEW.amount FROM financial_periods
          WHERE store_id = NEW.store_id AND period = NEW.period) NOT BETWEEN -9007199254740991 AND 9007199254740991
        OR NEW.amount + (SELECT COALESCE(SUM(amount), 0) FROM profit_setup_repayments
          WHERE period = NEW.period AND store_id != NEW.store_id) > 9007199254740991
        THEN RAISE(ABORT, 'setup repayment exceeds safe money range') END;
    END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_profit_setup_repayments_writable_update
    BEFORE UPDATE ON profit_setup_repayments
    BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM profit_distributions WHERE period = NEW.period)
        THEN RAISE(ABORT, 'setup repayment period is closed') END;
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM financial_periods
        WHERE store_id = NEW.store_id AND period = NEW.period AND status = 'LOCKED')
        THEN RAISE(ABORT, 'setup repayment store is not locked') END;
      SELECT CASE WHEN (SELECT final_profit - NEW.amount FROM financial_periods
          WHERE store_id = NEW.store_id AND period = NEW.period) NOT BETWEEN -9007199254740991 AND 9007199254740991
        OR NEW.amount + (SELECT COALESCE(SUM(amount), 0) FROM profit_setup_repayments
          WHERE period = NEW.period AND store_id != NEW.store_id) > 9007199254740991
        THEN RAISE(ABORT, 'setup repayment exceeds safe money range') END;
    END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_profit_setup_repayments_version BEFORE UPDATE ON profit_setup_repayments
    WHEN NEW.store_id IS NOT OLD.store_id OR NEW.period IS NOT OLD.period OR NEW.version IS NOT OLD.version + 1
    BEGIN SELECT RAISE(ABORT, 'setup repayment identity or version changed'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_profit_setup_repayments_no_delete BEFORE DELETE ON profit_setup_repayments
    BEGIN SELECT RAISE(ABORT, 'setup repayments cannot be deleted; save zero instead'); END;
