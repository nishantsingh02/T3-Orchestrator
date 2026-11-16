CREATE TABLE `marketing_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`taken_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `marketing_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `marketing_snapshots_source` ON `marketing_snapshots` (`source_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `marketing_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`secret` text,
	`status` text DEFAULT 'new' NOT NULL,
	`error` text,
	`last_fetched_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `marketing_sources_board` ON `marketing_sources` (`board_id`);--> statement-breakpoint
ALTER TABLE `boards` ADD `marketing_brief` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `idea_batches` ADD `suggested_brief` text;--> statement-breakpoint
ALTER TABLE `ideas` ADD `kind` text DEFAULT 'build' NOT NULL;--> statement-breakpoint
ALTER TABLE `ideas` ADD `draft` text DEFAULT '' NOT NULL;