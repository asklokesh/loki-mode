CREATE TABLE `pr_state` (
	`pr_url` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`merged_at` text,
	`checked_at` text NOT NULL
);
