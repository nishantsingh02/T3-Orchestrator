CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`position` real NOT NULL,
	`plan_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `milestones_board_number` ON `milestones` (`board_id`,`number`);--> statement-breakpoint
ALTER TABLE `boards` ADD `next_milestone_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `milestone_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `dismissed_follow_ups` text DEFAULT '[]' NOT NULL;