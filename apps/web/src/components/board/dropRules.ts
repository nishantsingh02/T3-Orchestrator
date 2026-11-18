// Drag and drop between lanes (spec §14.2). Everything not listed here is refused.
import type { TaskAction } from '@t3-orchestra/shared';
import type { BoardLane } from '@/lib/stage';

export interface DropRule {
  action: TaskAction;
  /** Shown on the target lane while dragging. */
  hint: string;
  confirm?: boolean;
  /** The drop position is kept (PATCH position after the move). */
  keepsPosition?: boolean;
}

export function dropRule(from: BoardLane, to: BoardLane): DropRule | null {
  if (from === 'backlog' && to === 'ready') return { action: 'move-to-ready', hint: 'Move to Ready', keepsPosition: true };
  if (from === 'ready' && to === 'backlog')
    return { action: 'move-to-backlog', hint: 'Move to Backlog', keepsPosition: true };
  if ((from === 'backlog' || from === 'ready') && to === 'running') return { action: 'start', hint: 'Drop to start' };
  if (from === 'human_review' && to === 'done') return { action: 'mark-done', hint: 'Mark done', confirm: true };
  if (from === 'failed' && to === 'backlog')
    return { action: 'move-to-backlog', hint: 'Move back to Backlog', keepsPosition: true };
  return null;
}

/** Lanes where dragging within the lane reorders (position matters to the scheduler). */
export const REORDERABLE: ReadonlySet<BoardLane> = new Set(['backlog', 'ready']);

/** Why a drop is refused, for the toast. */
export function refusalReason(from: BoardLane, to: BoardLane): string {
  if (to === 'needs_input' || to === 'ai_review') return 'Cards move there on their own as the agents work.';
  if (to === 'human_review') return 'Tasks reach Human Review when their run (and AI review) finishes.';
  if (to === 'failed') return 'Tasks only fail on their own. Use Discard to drop a task.';
  if (to === 'discarded') return 'Use Discard in the task drawer.';
  if (to === 'done') return 'Only tasks in Human Review can be marked done.';
  if (to === 'running') return 'Only Backlog and Ready tasks can be started.';
  if (from === 'human_review') return 'Use the Review tab to request changes, merge, or discard.';
  if (to === 'ready') return 'Only Backlog tasks can move to Ready.';
  return 'That move is not supported.';
}
