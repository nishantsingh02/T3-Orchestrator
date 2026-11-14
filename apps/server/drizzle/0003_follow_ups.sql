ALTER TABLE `tasks` ADD `follow_up_of` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `follow_up_text` text;--> statement-breakpoint
-- Link follow-ups added before these columns existed, by the footer createFollowUp writes.
UPDATE `tasks` SET
  `follow_up_of` = (
    SELECT p.`id` FROM `tasks` p
    WHERE p.`board_id` = `tasks`.`board_id`
      AND instr(`tasks`.`description`, char(10) || char(10) || '_Follow-up suggested by the agent on #' || p.`number` || ' ') > 0
  ),
  `follow_up_text` = substr(`description`, 1, instr(`description`, char(10) || char(10) || '_Follow-up suggested by the agent on #') - 1)
WHERE instr(`description`, char(10) || char(10) || '_Follow-up suggested by the agent on #') > 0;
