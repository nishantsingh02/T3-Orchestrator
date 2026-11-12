// The task transition table (spec §6.3). Pure: the server's transition() applies it inside a
// SQLite transaction and performs the side effects. Nothing else may change a task's stage.
import type { Stage, StageReason } from './enums.ts';

export type FailedRunStatus = 'failed' | 'interrupted' | 'cancelled' | 'rolled_back';

export type TaskEvent =
  | { type: 'user.move_to_ready' }
  | { type: 'user.move_to_backlog' }
  | { type: 'user.start' }
  | { type: 'scheduler.start' }
  /** An implement-type run finished with status done (or without a result block). */
  | { type: 'run.done'; skipReview: boolean; prRun?: boolean }
  | { type: 'run.blocked' }
  /** The run ended with HTML design options for the user to pick from. */
  | { type: 'run.options' }
  | { type: 'run.failed'; status: FailedRunStatus }
  /** start/send could not be confirmed (§15.3). */
  | { type: 'run.start_failed' }
  | { type: 'review.pass' }
  | { type: 'review.changes'; roundsLeft: boolean }
  | { type: 'review.failed' }
  | { type: 'user.rerun_review' }
  | { type: 'user.request_changes' }
  | { type: 'user.send_message' }
  | { type: 'user.choose_design' }
  | { type: 'user.approve'; outcome: 'merged' | 'conflict' | 'manual' }
  /** Approve without the user: the AI review passed with a score under the board's limit. */
  | { type: 'auto.approve'; outcome: 'merged' | 'conflict' | 'manual' }
  | { type: 'user.update_branch' }
  | { type: 'user.open_pr' }
  | { type: 'user.mark_done' }
  | { type: 'pr.merged' }
  | { type: 'user.resume' }
  | { type: 'user.retry_fresh' }
  | { type: 'user.discard' }
  | { type: 'thread.missing' };

export type TaskEventType = TaskEvent['type'];

export interface TransitionTarget {
  to: Stage;
  reason: StageReason | null;
}

const FAILED_REASON: Record<FailedRunStatus, StageReason> = {
  failed: 'run_failed',
  rolled_back: 'run_failed',
  interrupted: 'run_interrupted',
  cancelled: 'run_cancelled',
};

/**
 * Returns the target stage for `event` from `from`, or null when the transition is not allowed.
 * `reason` is the new stageReason (null clears it).
 */
export function resolveTransition(from: Stage, event: TaskEvent): TransitionTarget | null {
  const allow = (stages: Stage[], to: Stage, reason: StageReason | null = null) =>
    stages.includes(from) ? { to, reason } : null;

  switch (event.type) {
    case 'user.move_to_ready':
      return allow(['backlog'], 'ready');
    case 'user.move_to_backlog':
      return allow(['ready', 'failed'], 'backlog');
    case 'user.start':
    case 'scheduler.start':
      return allow(['backlog', 'ready'], 'implementing');
    case 'run.done':
      if (event.prRun) return allow(['implementing'], 'human_review', 'pr_opened');
      return event.skipReview
        ? allow(['implementing'], 'human_review', 'ai_review_skipped')
        : allow(['implementing'], 'ai_review');
    case 'run.blocked':
      return allow(['implementing'], 'failed', 'agent_blocked');
    case 'run.options':
      return allow(['implementing'], 'human_review', 'design_options');
    case 'run.failed':
      return allow(['implementing'], 'failed', FAILED_REASON[event.status]);
    case 'run.start_failed':
      return allow(['implementing'], 'failed', 'start_failed');
    case 'review.pass':
      return allow(['ai_review'], 'human_review', 'ai_passed');
    case 'review.changes':
      return event.roundsLeft
        ? allow(['ai_review'], 'implementing')
        : allow(['ai_review'], 'human_review', 'ai_unresolved');
    case 'review.failed':
      return allow(['ai_review'], 'human_review', 'review_failed');
    case 'user.rerun_review':
      return allow(['human_review'], 'ai_review');
    case 'user.request_changes':
      return allow(['human_review'], 'implementing');
    case 'user.send_message':
      return allow(['human_review', 'failed'], 'implementing');
    case 'user.choose_design':
      return allow(['human_review'], 'implementing');
    case 'user.approve':
      if (event.outcome === 'conflict') return allow(['human_review'], 'human_review', 'merge_conflict');
      return allow(['human_review'], 'done');
    case 'auto.approve':
      if (event.outcome === 'conflict') return allow(['human_review'], 'human_review', 'merge_conflict');
      return allow(['human_review'], 'done', 'auto_approved');
    case 'user.update_branch':
      return allow(['human_review'], 'implementing');
    case 'user.open_pr':
      return allow(['human_review'], 'implementing');
    case 'user.mark_done':
    case 'pr.merged':
      return allow(['human_review'], 'done');
    case 'user.resume':
    case 'user.retry_fresh':
      return allow(['failed'], 'implementing');
    case 'user.discard':
      return allow(['backlog', 'ready', 'human_review', 'done', 'failed'], 'discarded');
    case 'thread.missing':
      return allow(['implementing', 'ai_review'], 'failed', 'thread_missing');
  }
}

/** Stages that occupy a parallel slot (spec §3, §21.1: needs-input threads count too). */
export const SLOT_STAGES: readonly Stage[] = ['implementing', 'ai_review'];

/** Stages in which a task's thread may be running an agent turn. */
export function isActiveStage(stage: Stage): boolean {
  return SLOT_STAGES.includes(stage);
}
