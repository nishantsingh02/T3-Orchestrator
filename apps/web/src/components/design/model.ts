import type { DesignOptionView, DesignPick, DesignRoundView, TaskView } from '@t3-orchestra/shared';
import type { BadgeProps } from '@/components/ui/badge';

export const optionKey = (o: { round: number; file: string }) => `${o.round}/${o.file}`;

/** Is the task waiting in Human Review for the user to pick a design? */
export const awaitingDesign = (task: Pick<TaskView, 'stage' | 'stageReason'>) =>
  task.stage === 'human_review' && task.stageReason === 'design_options';

/** The round the user can pick from right now (by the live task, not a possibly older detail fetch). */
export function openRound(task: TaskView, rounds: readonly DesignRoundView[]): DesignRoundView | null {
  const last = rounds.at(-1);
  return awaitingDesign(task) && last?.status === 'open' ? last : null;
}

export function findOption(rounds: readonly DesignRoundView[], ref: { round: number; file: string }): DesignOptionView | undefined {
  return rounds.find((r) => r.round === ref.round)?.options.find((o) => o.file === ref.file);
}

export function roundBadge(r: DesignRoundView, open: DesignRoundView | null): { label: string; variant: BadgeProps['variant'] } {
  if (open?.id === r.id) return { label: 'Waiting for you', variant: 'info' };
  if (r.status === 'chosen') return { label: 'Built', variant: 'success' };
  if (r.status === 'more') return { label: 'Asked for more', variant: 'default' };
  return { label: 'No pick', variant: 'outline' };
}

/** Rounds (by number) whose decision included this option. */
export function pickedIn(rounds: readonly DesignRoundView[], o: { round: number; file: string }): number[] {
  return rounds.filter((r) => r.choice?.picks.some((p) => optionKey(p) === optionKey(o))).map((r) => r.round);
}

/** "B · Top tabs" */
export const optionLabel = (o: Pick<DesignOptionView, 'letter' | 'title'>) => `${o.letter} · ${o.title}`;

export type Draft = { picks: DesignPick[]; notes: string };
export const EMPTY_DRAFT: Draft = { picks: [], notes: '' };
export const draftKey = (taskId: string, round: number) => `designDraft:${taskId}:${round}`;
