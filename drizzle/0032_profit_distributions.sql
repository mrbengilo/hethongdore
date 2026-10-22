CREATE TABLE `profit_distributions` (
	`id` text PRIMARY KEY NOT NULL,
	`period` text NOT NULL,
	`status` text DEFAULT 'LOCKED' NOT NULL,
	`policy_version_id` text NOT NULL,
	`config_version` integer NOT NULL,
	`policy_snapshot_json` text NOT NULL,
	`total_final_profit` integer NOT NULL,
	`total_distributable_profit` integer NOT NULL,
	`store_count` integer NOT NULL,
	`member_count` integer NOT NULL,
	`closed_by` text NOT NULL,
	`closed_at` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`policy_version_id`) REFERENCES `financial_policy_versions`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT `profit_distributions_period_format` CHECK (`profit_distributions`.`period` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND CAST(substr(`profit_distributions`.`period`, 6, 2) AS integer) BETWEEN 1 AND 12),
	CONSTRAINT `profit_distributions_status` CHECK (`profit_distributions`.`status` = 'LOCKED'),
	CONSTRAINT `profit_distributions_config_version` CHECK (`profit_distributions`.`config_version` > 0),
	CONSTRAINT `profit_distributions_policy_snapshot_json` CHECK (json_valid(`profit_distributions`.`policy_snapshot_json`) AND json_type(`profit_distributions`.`policy_snapshot_json`) = 'object'),
	CONSTRAINT `profit_distributions_total_distributable` CHECK (`profit_distributions`.`total_distributable_profit` >= 0),
	CONSTRAINT `profit_distributions_store_count` CHECK (`profit_distributions`.`store_count` > 0),
	CONSTRAINT `profit_distributions_member_count` CHECK (`profit_distributions`.`member_count` > 0),
	CONSTRAINT `profit_distributions_closed_by` CHECK (length(trim(`profit_distributions`.`closed_by`)) > 0),
	CONSTRAINT `profit_distributions_reason` CHECK (length(trim(`profit_distributions`.`reason`)) > 0),
	CONSTRAINT `profit_distributions_closed_at` CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', `profit_distributions`.`closed_at`) = `profit_distributions`.`closed_at`),
	CONSTRAINT `profit_distributions_created_at` CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', `profit_distributions`.`created_at`) = `profit_distributions`.`created_at`)
);
--> statement-breakpoint
CREATE TABLE `profit_distribution_stores` (
	`id` text PRIMARY KEY NOT NULL,
	`distribution_id` text NOT NULL,
	`store_id` text NOT NULL,
	`store_name_snapshot` text NOT NULL,
	`financial_period_id` text NOT NULL,
	`financial_period_revision` integer NOT NULL,
	`policy_version_id` text NOT NULL,
	`config_version` integer NOT NULL,
	`final_profit` integer NOT NULL,
	`distributable_profit` integer NOT NULL,
	`financial_snapshot_json` text NOT NULL,
	`ordinal` integer NOT NULL,
	FOREIGN KEY (`distribution_id`) REFERENCES `profit_distributions`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`financial_period_id`) REFERENCES `financial_periods`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`policy_version_id`) REFERENCES `financial_policy_versions`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT `profit_distribution_stores_name` CHECK (length(trim(`profit_distribution_stores`.`store_name_snapshot`)) > 0),
	CONSTRAINT `profit_distribution_stores_revision` CHECK (`profit_distribution_stores`.`financial_period_revision` >= 0),
	CONSTRAINT `profit_distribution_stores_config_version` CHECK (`profit_distribution_stores`.`config_version` > 0),
	CONSTRAINT `profit_distribution_stores_distributable` CHECK (`profit_distribution_stores`.`distributable_profit` >= 0),
	CONSTRAINT `profit_distribution_stores_formula` CHECK (`profit_distribution_stores`.`distributable_profit` = CASE WHEN `profit_distribution_stores`.`final_profit` > 0 THEN `profit_distribution_stores`.`final_profit` ELSE 0 END),
	CONSTRAINT `profit_distribution_stores_snapshot_json` CHECK (json_valid(`profit_distribution_stores`.`financial_snapshot_json`) AND json_type(`profit_distribution_stores`.`financial_snapshot_json`) = 'object'),
	CONSTRAINT `profit_distribution_stores_ordinal` CHECK (`profit_distribution_stores`.`ordinal` >= 0)
);
--> statement-breakpoint
CREATE TABLE `profit_distribution_members` (
	`id` text PRIMARY KEY NOT NULL,
	`distribution_id` text NOT NULL,
	`member_id` text NOT NULL,
	`member_name_snapshot` text NOT NULL,
	`rate_basis_points` integer NOT NULL,
	`amount` integer NOT NULL,
	`member_snapshot_json` text NOT NULL,
	`ordinal` integer NOT NULL,
	FOREIGN KEY (`distribution_id`) REFERENCES `profit_distributions`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT `profit_distribution_members_member_id` CHECK (length(trim(`profit_distribution_members`.`member_id`)) > 0),
	CONSTRAINT `profit_distribution_members_name` CHECK (length(trim(`profit_distribution_members`.`member_name_snapshot`)) > 0),
	CONSTRAINT `profit_distribution_members_rate` CHECK (`profit_distribution_members`.`rate_basis_points` >= 0 AND `profit_distribution_members`.`rate_basis_points` <= 10000),
	CONSTRAINT `profit_distribution_members_amount` CHECK (`profit_distribution_members`.`amount` >= 0),
	CONSTRAINT `profit_distribution_members_snapshot_json` CHECK (json_valid(`profit_distribution_members`.`member_snapshot_json`) AND json_type(`profit_distribution_members`.`member_snapshot_json`) = 'object'),
	CONSTRAINT `profit_distribution_members_ordinal` CHECK (`profit_distribution_members`.`ordinal` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_profit_distributions_period` ON `profit_distributions` (`period`);
--> statement-breakpoint
CREATE INDEX `idx_profit_distributions_closed_at` ON `profit_distributions` (`closed_at`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_profit_distribution_stores_distribution_store` ON `profit_distribution_stores` (`distribution_id`,`store_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_profit_distribution_stores_financial_period` ON `profit_distribution_stores` (`financial_period_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_profit_distribution_stores_ordinal` ON `profit_distribution_stores` (`distribution_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_profit_distribution_members_distribution_member` ON `profit_distribution_members` (`distribution_id`,`member_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_profit_distribution_members_ordinal` ON `profit_distribution_members` (`distribution_id`,`ordinal`);
--> statement-breakpoint
CREATE TRIGGER `trg_profit_distributions_immutable_update`
BEFORE UPDATE ON `profit_distributions`
BEGIN SELECT RAISE(ABORT, 'profit distributions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_profit_distributions_immutable_delete`
BEFORE DELETE ON `profit_distributions`
BEGIN SELECT RAISE(ABORT, 'profit distributions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_profit_distribution_stores_bounded_insert`
BEFORE INSERT ON `profit_distribution_stores`
WHEN (SELECT COUNT(*) FROM `profit_distribution_stores` WHERE `distribution_id` = NEW.`distribution_id`)
  >= (SELECT `store_count` FROM `profit_distributions` WHERE `id` = NEW.`distribution_id`)
BEGIN SELECT RAISE(ABORT, 'profit distribution store rows are complete'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_profit_distribution_stores_immutable_update`
BEFORE UPDATE ON `profit_distribution_stores`
BEGIN SELECT RAISE(ABORT, 'profit distribution store rows are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_profit_distribution_stores_immutable_delete`
BEFORE DELETE ON `profit_distribution_stores`
BEGIN SELECT RAISE(ABORT, 'profit distribution store rows are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_profit_distribution_members_bounded_insert`
BEFORE INSERT ON `profit_distribution_members`
WHEN (SELECT COUNT(*) FROM `profit_distribution_members` WHERE `distribution_id` = NEW.`distribution_id`)
  >= (SELECT `member_count` FROM `profit_distributions` WHERE `id` = NEW.`distribution_id`)
BEGIN SELECT RAISE(ABORT, 'profit distribution member rows are complete'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_profit_distribution_members_immutable_update`
BEFORE UPDATE ON `profit_distribution_members`
BEGIN SELECT RAISE(ABORT, 'profit distribution member rows are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_profit_distribution_members_immutable_delete`
BEFORE DELETE ON `profit_distribution_members`
BEGIN SELECT RAISE(ABORT, 'profit distribution member rows are immutable'); END;
