ALTER TABLE `runs` ADD `group_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `unit_id` text;--> statement-breakpoint
CREATE INDEX `runs_group` ON `runs` (`group_id`);
