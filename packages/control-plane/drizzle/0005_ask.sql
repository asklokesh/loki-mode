CREATE TABLE IF NOT EXISTS `ask_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`repo` text,
	`provider` text NOT NULL,
	`model` text,
	`title` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ask_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`worker_pid` integer,
	`pgid` integer,
	`cost_usd` real,
	`error` text,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`thread_id`) REFERENCES `ask_threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ask_messages_thread_seq` ON `ask_messages` (`thread_id`,`seq`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ask_messages_status` ON `ask_messages` (`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ask_events` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`ts` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `ask_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ask_events_message_seq` ON `ask_events` (`message_id`,`seq`);
