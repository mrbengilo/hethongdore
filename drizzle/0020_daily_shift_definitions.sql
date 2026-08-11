CREATE TABLE IF NOT EXISTS `daily_shift_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`work_date` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`status` text NOT NULL DEFAULT 'ACTIVE' CHECK (`status` IN ('ACTIVE', 'DELETED')),
	`version` integer NOT NULL DEFAULT 1 CHECK (`version` >= 1),
	`client_request_id` text,
	`payload_hash` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_daily_shift_store_request`
ON `daily_shift_definitions` (`store_id`,`client_request_id`)
WHERE `client_request_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_daily_shift_store_date_identity`
ON `daily_shift_definitions` (`store_id`,`work_date`,`name_key`,`start_time`,`end_time`)
WHERE `status` = 'ACTIVE';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_daily_shift_store_date_status`
ON `daily_shift_definitions` (`store_id`,`work_date`,`status`,`start_time`,`id`);
--> statement-breakpoint
WITH parsed AS (
	SELECT store_id AS storeId, owner_id AS ownerId, created_at AS createdAt,
		CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.date') END AS workDate,
		CASE WHEN json_valid(data_json) THEN trim(json_extract(data_json, '$.shiftName')) END AS shiftName,
		CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.start') END AS startTime,
		CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.end') END AS endTime
	FROM business_records
	WHERE category = 'LICH_PHAN_CA' AND status != 'DELETED' AND store_id IS NOT NULL
), snapshots AS (
	SELECT storeId, workDate, shiftName, lower(shiftName) AS nameKey, startTime, endTime,
		COALESCE(MIN(ownerId), 'daily-shift-migration') AS createdBy,
		COALESCE(MIN(createdAt), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS createdAt
	FROM parsed
	WHERE workDate GLOB '????-??-??' AND shiftName IS NOT NULL AND shiftName != ''
		AND startTime GLOB '??:??' AND endTime GLOB '??:??'
	GROUP BY storeId, workDate, shiftName, startTime, endTime
)
INSERT OR IGNORE INTO daily_shift_definitions
	(id, store_id, work_date, name, name_key, start_time, end_time, status, version,
		client_request_id, payload_hash, created_by, created_at, updated_at, deleted_at)
SELECT 'daily-shift-migrated-' || lower(hex(randomblob(16))), storeId, workDate,
	shiftName, nameKey, startTime, endTime, 'ACTIVE', 1, NULL, NULL,
	createdBy, createdAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
FROM snapshots;
