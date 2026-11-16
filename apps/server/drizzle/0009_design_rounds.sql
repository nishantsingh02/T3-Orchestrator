CREATE TABLE `design_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`round` integer NOT NULL,
	`run_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`question` text,
	`summary` text,
	`options` text DEFAULT '[]' NOT NULL,
	`choice` text,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `design_rounds_task_round` ON `design_rounds` (`task_id`,`round`);