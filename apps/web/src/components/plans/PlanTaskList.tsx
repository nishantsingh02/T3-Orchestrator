// The live board tasks of one plan: a bar of where they stand, then the tasks, then their follow-ups.
import { COLUMN_ORDER, type TaskView } from '@t3-orchestra/shared';
import { RowList, TaskRow } from '@/components/overview/parts';
import { Tip } from '@/components/ui/tooltip';
import { LANE_LABELS, LANE_STYLE, laneFor, type BoardLane } from '@/lib/stage';
import { cn } from '@/lib/utils';
import type { PlanTasks } from './model';

/** Done-of-total for a plan's tasks, follow-ups included. */
export function planProgress(group: PlanTasks | undefined): { done: number; total: number } {
  const all = group ? [...group.planned, ...group.followUps] : [];
  return { done: all.filter((t) => t.stage === 'done').length, total: all.length };
}

/** "3/8 done", or "All done". */
export function ProgressText({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular">
      {done === total ? (
        <span className="font-medium text-success">All done</span>
      ) : (
        <>
          <span className="text-foreground">{done}</span>/{total} done
        </>
      )}
    </span>
  );
}

export function LaneBar({ tasks, className }: { tasks: readonly TaskView[]; className?: string }) {
  const counts = new Map<BoardLane, number>();
  for (const t of tasks) counts.set(laneFor(t), (counts.get(laneFor(t)) ?? 0) + 1);
  const parts = COLUMN_ORDER.filter((c) => (counts.get(c) ?? 0) > 0);
  if (parts.length === 0) return <div className={cn('h-1.5 rounded-full bg-muted', className)} />;
  return (
    <div className={cn('flex h-1.5 gap-[2px]', className)} role="img" aria-label="Tasks by column">
      {parts.map((c, i) => (
        <Tip key={c} content={`${LANE_LABELS[c]}: ${counts.get(c)}`}>
          <span
            className={cn('h-full min-w-[3px]', LANE_STYLE[c].dot, i === 0 && 'rounded-l-full', i === parts.length - 1 && 'rounded-r-full')}
            style={{ flexGrow: counts.get(c) }}
          />
        </Tip>
      ))}
    </div>
  );
}

const row = (t: TaskView) => <TaskRow key={t.id} task={t} meta={LANE_LABELS[laneFor(t)]} />;

export function PlanTaskList({ group, limit = 6 }: { group: PlanTasks; limit?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {group.planned.length > 0 && <RowList items={group.planned} limit={limit} render={row} />}
      {group.followUps.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            Follow-ups <span className="font-mono font-normal">{group.followUps.length}</span>
          </p>
          <RowList items={group.followUps} limit={limit} render={row} />
        </div>
      )}
    </div>
  );
}
