CREATE TABLE `events` (
	`source_id` text NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` text NOT NULL,
	`type` text NOT NULL,
	`stage` text,
	`data` text NOT NULL,
	`line_sha256` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`source_id`, `run_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `events_run_seq` ON `events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_type_ts` ON `events` (`type`,`ts`);--> statement-breakpoint
CREATE TABLE `runs` (
	`source_id` text NOT NULL,
	`run_id` text NOT NULL,
	`origin_repo` text,
	`issue_ref` text,
	`task_source` text,
	`provider` text,
	`model` text,
	`started_at` text,
	`ended_at` text,
	`verdict` text,
	`pr_url` text,
	`pr_draft` integer,
	`cost_usd` real,
	`partial_usd` real NOT NULL,
	`measured_sessions` integer NOT NULL,
	`total_sessions` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`wall_s` real,
	`last_seq` integer NOT NULL,
	`last_event_at` text,
	`tampered` integer NOT NULL,
	`conflict` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`source_id`, `run_id`)
);
--> statement-breakpoint
CREATE INDEX `runs_started` ON `runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `runs_verdict` ON `runs` (`verdict`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL
);
