CREATE TABLE `project_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`number` integer NOT NULL,
	`status` text NOT NULL,
	`thread_count` integer DEFAULT 0 NOT NULL,
	`threads_read` integer DEFAULT 0 NOT NULL,
	`thread_id` text,
	`thread_link` text,
	`run_id` text,
	`correction_sent` integer DEFAULT false NOT NULL,
	`summary` text,
	`next_steps` text DEFAULT '[]' NOT NULL,
	`text` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_imports_board_number` ON `project_imports` (`board_id`,`number`);--> statement-breakpoint
CREATE INDEX `project_imports_run` ON `project_imports` (`run_id`);