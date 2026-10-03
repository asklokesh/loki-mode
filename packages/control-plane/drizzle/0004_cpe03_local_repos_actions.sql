CREATE TABLE IF NOT EXISTS `actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`target` text,
	`result` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `actions_ts` ON `actions` (`ts`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `local_repos` (
	`source_id` text PRIMARY KEY NOT NULL,
	`realpath` text NOT NULL,
	`name` text NOT NULL,
	`discovered_at` text NOT NULL
);
