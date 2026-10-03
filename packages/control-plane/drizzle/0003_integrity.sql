ALTER TABLE `runs` ADD `attested` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `sig_checked` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `integrity_key_fp` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `integrity_reasons` text;
