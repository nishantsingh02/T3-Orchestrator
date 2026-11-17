CREATE TABLE `context_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`number` integer NOT NULL,
	`status` text NOT NULL,
	`fresh` integer DEFAULT false NOT NULL,
	`files` text DEFAULT '[]' NOT NULL,
	`thread_id` text,
	`thread_link` text,
	`run_id` text,
	`correction_sent` integer DEFAULT false NOT NULL,
	`summary` text,
	`stats` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_builds_board_number` ON `context_builds` (`board_id`,`number`);--> statement-breakpoint
CREATE INDEX `context_builds_run` ON `context_builds` (`run_id`);--> statement-breakpoint
CREATE TABLE `context_files` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`note` text,
	`uploaded_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_files_board_name` ON `context_files` (`board_id`,`name`);--> statement-breakpoint
CREATE TABLE `context_graphs` (
	`board_id` text PRIMARY KEY NOT NULL,
	`nodes` text DEFAULT '[]' NOT NULL,
	`edges` text DEFAULT '[]' NOT NULL,
	`digest` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `boards` ADD `context_auto_build` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `boards` ADD `context_in_prompts` integer DEFAULT true NOT NULL;