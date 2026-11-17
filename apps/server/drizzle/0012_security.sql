CREATE TABLE `security_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`number` integer NOT NULL,
	`scope` text NOT NULL,
	`focus` text DEFAULT '[]' NOT NULL,
	`paths` text DEFAULT '[]' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`base_sha` text,
	`head_sha` text,
	`status` text NOT NULL,
	`thread_id` text,
	`thread_link` text,
	`run_id` text,
	`correction_sent` integer DEFAULT false NOT NULL,
	`summary` text,
	`attack_surface` text,
	`coverage` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_audits_board_number` ON `security_audits` (`board_id`,`number`);--> statement-breakpoint
CREATE INDEX `security_audits_run` ON `security_audits` (`run_id`);--> statement-breakpoint
CREATE TABLE `security_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`number` integer NOT NULL,
	`source` text NOT NULL,
	`fingerprint` text NOT NULL,
	`audit_id` text,
	`scan_id` text,
	`severity` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`recommendation` text DEFAULT '' NOT NULL,
	`file` text,
	`line` integer,
	`cwe` text,
	`confidence` text DEFAULT 'medium' NOT NULL,
	`acceptance_criteria` text DEFAULT '[]' NOT NULL,
	`touches` text DEFAULT '[]' NOT NULL,
	`meta` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`dismiss_reason` text,
	`dismiss_note` text DEFAULT '' NOT NULL,
	`task_id` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	`resolved_audit_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_findings_board_number` ON `security_findings` (`board_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `security_findings_board_fingerprint` ON `security_findings` (`board_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `security_findings_board_status` ON `security_findings` (`board_id`,`status`);--> statement-breakpoint
CREATE TABLE `security_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`head_sha` text,
	`stats` text DEFAULT '{}' NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`fixed_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `security_scans_board` ON `security_scans` (`board_id`,`kind`,`created_at`);--> statement-breakpoint
ALTER TABLE `boards` ADD `security_brief` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `boards` ADD `security_review` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `boards` ADD `security_auto_scan` integer DEFAULT false NOT NULL;