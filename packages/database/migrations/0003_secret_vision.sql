ALTER TABLE `automation_runs` ADD `note` text;--> statement-breakpoint
ALTER TABLE `automations` ADD `instruction` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `automations` ADD `options_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `automations` ADD `state_json` text DEFAULT '{}' NOT NULL;