ALTER TABLE `boards` ADD `auto_approve_below` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `review_score` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `review_score_reason` text;