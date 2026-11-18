CREATE TABLE `plan_spec_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`round` integer NOT NULL,
	`run_id` text,
	`spec` text DEFAULT '' NOT NULL,
	`user_spec` text,
	`changes` text DEFAULT '' NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`answers` text,
	`feedback` text,
	`raw_text` text NOT NULL,
	`validation_errors` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_spec_rounds_plan_round` ON `plan_spec_rounds` (`plan_id`,`round`);