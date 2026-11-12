CREATE TABLE `boards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`short` text NOT NULL,
	`project_path` text NOT NULL,
	`t3_project_id` text,
	`base_branch` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`auto_run` integer DEFAULT false NOT NULL,
	`max_parallel` integer DEFAULT 3 NOT NULL,
	`accept_into` text DEFAULT 'ready' NOT NULL,
	`ai_review` integer DEFAULT true NOT NULL,
	`skip_review_for_trivial` integer DEFAULT true NOT NULL,
	`max_fix_rounds` integer DEFAULT 2 NOT NULL,
	`review_strictness` text DEFAULT 'major' NOT NULL,
	`avoid_overlap` integer DEFAULT true NOT NULL,
	`merge_strategy` text DEFAULT 'local' NOT NULL,
	`default_provider` text,
	`default_model` text,
	`planner_model` text,
	`reviewer_model` text,
	`next_task_number` integer DEFAULT 1 NOT NULL,
	`next_plan_number` integer DEFAULT 1 NOT NULL,
	`observed_runtime_mode` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `boards_slug_unique` ON `boards` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `boards_short_unique` ON `boards` (`short`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` text NOT NULL,
	`task_id` text,
	`plan_id` text,
	`run_id` text,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_task` ON `events` (`task_id`,`id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`board_id` text NOT NULL,
	`task_id` text,
	`plan_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_key_unique` ON `notifications` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `plan_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`version` integer NOT NULL,
	`source` text DEFAULT 'agent' NOT NULL,
	`run_id` text,
	`raw_text` text NOT NULL,
	`parsed` text,
	`validation_errors` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_versions_plan_version` ON `plan_versions` (`plan_id`,`version`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`options` text NOT NULL,
	`status` text NOT NULL,
	`attention` text,
	`thread_id` text,
	`thread_link` text,
	`current_version` integer DEFAULT 0 NOT NULL,
	`correction_sent` integer DEFAULT false NOT NULL,
	`accepted_keys` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plans_board_number` ON `plans` (`board_id`,`number`);--> statement-breakpoint
CREATE TABLE `review_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`round` integer NOT NULL,
	`severity` text NOT NULL,
	`file` text,
	`line` integer,
	`title` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`suggestion` text,
	`status` text DEFAULT 'open' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`task_id` text,
	`plan_id` text,
	`kind` text NOT NULL,
	`thread_id` text,
	`thread_link` text,
	`thread_role` text NOT NULL,
	`marker` text,
	`launch` text,
	`round` integer,
	`baseline_run_id` text,
	`t3_run_id` text,
	`external` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`start_item_count` integer,
	`prompt_text` text NOT NULL,
	`result_raw` text,
	`result_json` text,
	`error` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_status` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX `runs_thread` ON `runs` (`thread_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_deps` (
	`task_id` text NOT NULL,
	`depends_on_task_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_task_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`number` integer NOT NULL,
	`plan_id` text,
	`plan_key` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`acceptance_criteria` text DEFAULT '[]' NOT NULL,
	`category` text DEFAULT 'feature' NOT NULL,
	`complexity` text DEFAULT 'medium' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`touches` text DEFAULT '[]' NOT NULL,
	`position` real NOT NULL,
	`stage` text NOT NULL,
	`stage_reason` text,
	`attention` text,
	`thread_id` text,
	`thread_link` text,
	`branch` text,
	`worktree_path` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`fix_round` integer DEFAULT 0 NOT NULL,
	`review_round` integer DEFAULT 0 NOT NULL,
	`skip_ai_review` integer DEFAULT false NOT NULL,
	`provider_override` text,
	`model_override` text,
	`last_result` text,
	`last_summary` text,
	`last_message` text,
	`result_missing` integer DEFAULT false NOT NULL,
	`pr_url` text,
	`last_thread_status` text,
	`last_item_count` integer,
	`last_activity_at` text,
	`diff_stat` text,
	`started_at` text,
	`completed_at` text,
	`activity_since_review` integer DEFAULT false NOT NULL,
	`last_t3_run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_board_number` ON `tasks` (`board_id`,`number`);--> statement-breakpoint
CREATE INDEX `tasks_board_stage` ON `tasks` (`board_id`,`stage`);