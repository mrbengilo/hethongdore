ALTER TABLE `shift_sessions` ADD `clock_in_latitude` real;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `clock_in_longitude` real;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `clock_in_accuracy_meters` real;
--> statement-breakpoint
ALTER TABLE `shift_sessions` ADD `clock_in_location_captured_at` text;
