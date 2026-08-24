-- The cashflow ledger records actual money movements only. Finance/reporting
-- continues to calculate profit from the originating business transactions,
-- never by summing these rows.
ALTER TABLE `cashflow_entries` ADD COLUMN `client_request_id` text;
--> statement-breakpoint
ALTER TABLE `cashflow_entries` ADD COLUMN `payload_hash` text;
--> statement-breakpoint
ALTER TABLE `cashflow_entries` ADD COLUMN `reverses_entry_id` text REFERENCES `cashflow_entries`(`id`) ON UPDATE restrict ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_cashflow_entries_actor_request`
  ON `cashflow_entries` (`store_id`, `created_by`, `client_request_id`)
  WHERE `client_request_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_cashflow_entries_reversal`
  ON `cashflow_entries` (`reverses_entry_id`)
  WHERE `reverses_entry_id` IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_cashflow_entries_require_metadata`
BEFORE INSERT ON `cashflow_entries`
WHEN NEW.`client_request_id` IS NULL
  OR length(trim(NEW.`client_request_id`)) NOT BETWEEN 16 AND 200
  OR NEW.`payload_hash` IS NULL
  OR length(NEW.`payload_hash`) != 64
  OR NEW.`payload_hash` GLOB '*[^0-9a-f]*'
  OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`occurred_at`) IS NOT NEW.`occurred_at`
BEGIN
  SELECT RAISE(ABORT, 'cashflow entry requires idempotency metadata and canonical ISO occurredAt');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_cashflow_entries_idempotency_conflict`
BEFORE INSERT ON `cashflow_entries`
WHEN EXISTS (
  SELECT 1
  FROM `cashflow_entries` AS existing
  WHERE (
    (
      existing.`store_id` = NEW.`store_id`
      AND existing.`source_type` = NEW.`source_type`
      AND existing.`source_id` = NEW.`source_id`
    ) OR (
      existing.`store_id` = NEW.`store_id`
      AND existing.`created_by` = NEW.`created_by`
      AND existing.`client_request_id` = NEW.`client_request_id`
    )
  )
    AND (existing.`payload_hash` IS NULL OR existing.`payload_hash` != NEW.`payload_hash`)
)
BEGIN
  SELECT RAISE(ABORT, 'cashflow idempotency conflict');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_cashflow_entries_reversal_validate`
BEFORE INSERT ON `cashflow_entries`
WHEN (NEW.`reverses_entry_id` IS NULL AND NEW.`source_type` = 'REVERSAL')
  OR (NEW.`reverses_entry_id` IS NOT NULL AND (
    NEW.`source_type` != 'REVERSAL'
    OR NEW.`source_id` != NEW.`reverses_entry_id`
    OR NOT EXISTS (
    SELECT 1
    FROM `cashflow_entries` AS original
    WHERE original.`id` = NEW.`reverses_entry_id`
      AND original.`reverses_entry_id` IS NULL
      AND original.`store_id` = NEW.`store_id`
      AND original.`category` = NEW.`category`
      AND original.`amount` = NEW.`amount`
      AND original.`direction` != NEW.`direction`
      AND NEW.`occurred_at` >= original.`occurred_at`
      AND NEW.`id` != original.`id`
    )
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid cashflow reversal');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_cashflow_entries_locked_insert`
BEFORE INSERT ON `cashflow_entries`
WHEN EXISTS (
  SELECT 1
  FROM `financial_periods` AS locked_period
  WHERE locked_period.`store_id` = NEW.`store_id`
    AND locked_period.`period` = strftime('%Y-%m', NEW.`occurred_at`, '+7 hours')
    AND locked_period.`status` = 'LOCKED'
)
BEGIN
  SELECT RAISE(ABORT, 'LOCKED financial period does not accept cashflow entries');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_cashflow_entries_append_only_update`
BEFORE UPDATE ON `cashflow_entries`
BEGIN
  SELECT RAISE(ABORT, 'cashflow ledger is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_cashflow_entries_append_only_delete`
BEFORE DELETE ON `cashflow_entries`
BEGIN
  SELECT RAISE(ABORT, 'cashflow ledger is append-only');
END;
