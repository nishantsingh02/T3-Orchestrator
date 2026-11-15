CREATE TABLE `insight_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`thread_id` text,
	`thread_link` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insight_chats_board_number` ON `insight_chats` (`board_id`,`number`);--> statement-breakpoint
CREATE TABLE `insight_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`board_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`chat_id`) REFERENCES `insight_chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insight_messages_chat_seq` ON `insight_messages` (`chat_id`,`seq`);--> statement-breakpoint
CREATE INDEX `insight_messages_run` ON `insight_messages` (`run_id`);