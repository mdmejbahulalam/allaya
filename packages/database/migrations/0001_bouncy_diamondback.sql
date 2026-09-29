CREATE TABLE `file_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`target` text,
	`undoable` integer NOT NULL,
	`note` text,
	`data_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`undone_at` integer
);
--> statement-breakpoint
CREATE INDEX `file_operations_created_idx` ON `file_operations` (`created_at`);