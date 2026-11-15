CREATE TABLE `idea_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`number` integer NOT NULL,
	`category` text NOT NULL,
	`status` text NOT NULL,
	`thread_id` text,
	`thread_link` text,
	`run_id` text,
	`correction_sent` integer DEFAULT false NOT NULL,
	`summary` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idea_batches_board_number` ON `idea_batches` (`board_id`,`number`);--> statement-breakpoint
CREATE INDEX `idea_batches_run` ON `idea_batches` (`run_id`);--> statement-breakpoint
CREATE TABLE `ideas` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`acceptance_criteria` text DEFAULT '[]' NOT NULL,
	`touches` text DEFAULT '[]' NOT NULL,
	`impact` text NOT NULL,
	`difficulty` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`task_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `idea_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ideas_board_status` ON `ideas` (`board_id`,`status`);--> statement-breakpoint
CREATE INDEX `ideas_batch` ON `ideas` (`batch_id`);