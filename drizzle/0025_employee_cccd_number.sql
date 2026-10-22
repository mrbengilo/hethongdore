ALTER TABLE `employees` ADD `cccd_number` text CHECK (
  `cccd_number` IS NULL OR (
    length(`cccd_number`) = 12
    AND `cccd_number` NOT GLOB '*[^0-9]*'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_employees_live_cccd_number`
ON `employees` (`cccd_number`)
WHERE `cccd_number` IS NOT NULL
  AND `status` != 'ARCHIVED'
  AND `deleted_at` IS NULL;
