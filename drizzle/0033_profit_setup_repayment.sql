-- Additive only: historical distributions keep their original rounding method.
ALTER TABLE profit_distributions ADD COLUMN allocation_method TEXT NOT NULL DEFAULT 'AGGREGATE'
  CHECK (allocation_method IN ('AGGREGATE', 'PER_STORE'));
--> statement-breakpoint
-- distributable_profit remains the original locked financial snapshot value.
-- The amount available for sharing is max(0, final_profit - setup_repayment).
ALTER TABLE profit_distribution_stores ADD COLUMN setup_repayment INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(setup_repayment) = 'integer' AND setup_repayment BETWEEN 0 AND 9007199254740991);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_profit_distribution_setup_method
BEFORE INSERT ON profit_distribution_stores
WHEN NEW.setup_repayment != 0 AND
  (SELECT allocation_method FROM profit_distributions WHERE id = NEW.distribution_id) != 'PER_STORE'
BEGIN SELECT RAISE(ABORT, 'Setup repayment requires per-store allocation'); END;
