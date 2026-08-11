CREATE TABLE IF NOT EXISTS `order_code_sequence` (
	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
	`last_value` integer NOT NULL CHECK (`last_value` >= 0)
);
--> statement-breakpoint
INSERT INTO `order_code_sequence` (`id`, `last_value`)
SELECT 1, MAX(
	(SELECT COUNT(*) FROM `orders`),
	COALESCE((
		SELECT MAX(CAST(substr(`code`, 3) AS INTEGER))
		FROM `orders`
		WHERE `code` GLOB 'DH[0-9]*'
			AND length(substr(`code`, 3)) = 5
			AND substr(`code`, 3) NOT GLOB '*[^0-9]*'
	), 0)
)
ON CONFLICT(`id`) DO UPDATE SET
	`last_value` = MAX(`order_code_sequence`.`last_value`, excluded.`last_value`);
