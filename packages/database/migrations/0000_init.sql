CREATE TABLE `activity_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`actor` text NOT NULL,
	`task_id` text,
	`tool` text,
	`action` text NOT NULL,
	`result` text NOT NULL,
	`risk` text,
	`permission` text,
	`error` text,
	`details_json` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activity_logs_timestamp_idx` ON `activity_logs` (`timestamp`);--> statement-breakpoint
CREATE INDEX `activity_logs_task_idx` ON `activity_logs` (`task_id`);--> statement-breakpoint
CREATE TABLE `api_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`encrypted_key` text NOT NULL,
	`masked_hint` text NOT NULL,
	`last_tested_at` integer,
	`last_test_ok` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_credentials_provider_uq` ON `api_credentials` (`provider_id`);--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`triggered_by` text NOT NULL,
	`task_id` text,
	`log_json` text DEFAULT '[]' NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `automation_runs_automation_idx` ON `automation_runs` (`automation_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `automation_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`node_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`next_json` text DEFAULT '[]' NOT NULL,
	`position_x` real DEFAULT 0 NOT NULL,
	`position_y` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_steps_node_uq` ON `automation_steps` (`automation_id`,`node_id`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT false NOT NULL,
	`trigger_type` text DEFAULT 'manual' NOT NULL,
	`trigger_json` text DEFAULT '{}' NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `automations_next_run_idx` ON `automations` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`language` text,
	`model_id` text,
	`pinned` integer DEFAULT false NOT NULL,
	`summary` text,
	`summarized_through_message_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `conversations_updated_idx` ON `conversations` (`updated_at`);--> statement-breakpoint
CREATE TABLE `file_bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`path` text NOT NULL,
	`kind` text DEFAULT 'user' NOT NULL,
	`last_accessed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_bookmarks_path_uq` ON `file_bookmarks` (`path`);--> statement-breakpoint
CREATE TABLE `installed_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'exe' NOT NULL,
	`executable_path` text,
	`launch_target` text,
	`automation_support` text DEFAULT 'none' NOT NULL,
	`last_launched_at` integer,
	`discovered_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installed_apps_name_uq` ON `installed_apps` (`name`);--> statement-breakpoint
CREATE TABLE `language_settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`ui_language` text DEFAULT 'auto' NOT NULL,
	`response_language` text DEFAULT 'auto' NOT NULL,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`numeral_style` text DEFAULT 'auto' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_category_key_uq` ON `memories` (`category`,`key`);--> statement-breakpoint
CREATE INDEX `memories_category_idx` ON `memories` (`category`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`language` text,
	`task_id` text,
	`metadata_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `model_routing` (
	`purpose` text PRIMARY KEY NOT NULL,
	`provider_id` text,
	`model_id` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`display_name` text NOT NULL,
	`capabilities_json` text NOT NULL,
	`cost_json` text,
	`enabled` integer DEFAULT true NOT NULL,
	`discovered_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_provider_model_uq` ON `models` (`provider_id`,`model_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`read` integer DEFAULT false NOT NULL,
	`data_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_created_idx` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`mode` text NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_subject_scope_uq` ON `permissions` (`subject`,`scope`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'not_configured' NOT NULL,
	`last_checked_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `seed_state` (
	`name` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_events_task_seq_uq` ON `task_events` (`task_id`,`seq`);--> statement-breakpoint
CREATE TABLE `task_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`tool_name` text,
	`arguments_json` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_steps_task_position_uq` ON `task_steps` (`task_id`,`position`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`title` text NOT NULL,
	`request` text NOT NULL,
	`language` text,
	`state` text DEFAULT 'CREATED' NOT NULL,
	`source` text DEFAULT 'chat' NOT NULL,
	`complexity` text,
	`model_id` text,
	`risk_level` text DEFAULT 'LOW' NOT NULL,
	`plan_json` text,
	`result_summary` text,
	`error_json` text,
	`automation_run_id` text,
	`files_changed` integer DEFAULT 0 NOT NULL,
	`action_count` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tasks_state_idx` ON `tasks` (`state`);--> statement-breakpoint
CREATE INDEX `tasks_created_idx` ON `tasks` (`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_conversation_idx` ON `tasks` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`step_id` text,
	`tool_name` text NOT NULL,
	`arguments_json` text NOT NULL,
	`risk` text NOT NULL,
	`permission_decision` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `task_steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tool_calls_task_idx` ON `tool_calls` (`task_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_tool_idx` ON `tool_calls` (`tool_name`);--> statement-breakpoint
CREATE TABLE `tool_results` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_call_id` text NOT NULL,
	`ok` integer NOT NULL,
	`output_json` text,
	`observation_json` text,
	`verification_json` text,
	`error_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tool_call_id`) REFERENCES `tool_calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_results_call_uq` ON `tool_results` (`tool_call_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`onboarding_completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `voice_settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`stt_provider_id` text,
	`tts_provider_id` text,
	`voice_id` text,
	`speech_rate` real DEFAULT 1 NOT NULL,
	`speech_pitch` real DEFAULT 1 NOT NULL,
	`vad_sensitivity` real DEFAULT 0.5 NOT NULL,
	`min_confidence` real DEFAULT 0.6 NOT NULL,
	`speak_responses` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
