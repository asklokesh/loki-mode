CREATE TABLE `audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`detail` text NOT NULL
);
