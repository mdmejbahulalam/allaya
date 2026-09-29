ALTER TABLE `memories` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `use_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `last_used_at` integer;