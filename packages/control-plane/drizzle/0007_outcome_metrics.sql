ALTER TABLE `runs` ADD `cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `cache_creation_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `fix_rounds` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `escalations` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `size` text;--> statement-breakpoint
-- L002: input_tokens no longer folds in cache tokens and the new columns start at 0, so every row that still has its events is rebuilt by the boot recompute (recomputeLegacy re-judges a row whose key fingerprint differs).
UPDATE `runs` SET `integrity_key_fp` = NULL WHERE EXISTS (SELECT 1 FROM `events` e WHERE e.`source_id` = `runs`.`source_id` AND e.`run_id` = `runs`.`run_id`);
