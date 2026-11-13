import type { TaskView } from '@t3-orchestra/shared';
import { milestoneKey, useOptionalBoardContext } from '@/components/board/BoardContext';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { stageLabel } from '@/lib/stage';

const chip = 'inline-flex h-[18px] items-center rounded-[4px] border px-1.5 text-[10.5px] leading-none whitespace-nowrap';

/** category · complexity · priority (only high coloured) · after #3 #4 (red when blocked). */
export function TaskChips({ task, className }: { task: TaskView; className?: string }) {
  const milestone = useOptionalBoardContext()?.milestones.find((m) => m.id === task.milestoneId);
  const blocked = new Set(task.blockedBy.map((d) => d.id));
  const waiting = new Set(task.waitingOn.map((d) => d.id));
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {milestone && (
        <Tip content={`Milestone ${milestoneKey(milestone)}: ${milestone.title}`}>
          <span className={cn(chip, 'border-primary/30 bg-primary/8 font-mono text-primary')}>{milestoneKey(milestone)}</span>
        </Tip>
      )}
      <span className={cn(chip, 'border-border text-muted-foreground')}>{task.category}</span>
      <span className={cn(chip, 'border-border text-muted-foreground')}>{task.complexity}</span>
      <span
        className={cn(
          chip,
          task.priority === 'high'
            ? 'border-warning/40 bg-warning/12 font-medium text-warning'
            : 'border-border text-muted-foreground',
        )}
      >
        {task.priority}
      </span>
      {task.deps.length > 0 && (
        <span className="inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground">
          <span className="mr-0.5">after</span>
          {task.deps.map((d) => {
            const isBlocked = blocked.has(d.id);
            const isDone = d.stage === 'done';
            return (
              <Tip
                key={d.id}
                content={`#${d.number} ${d.title} — ${isBlocked ? `blocked (${d.stage})` : stageLabel(d.stage)}`}
              >
                <span
                  className={cn(
                    chip,
                    'px-1 font-mono',
                    isBlocked && 'border-destructive/45 bg-destructive/12 text-destructive',
                    !isBlocked && waiting.has(d.id) && 'border-border text-foreground/80',
                    isDone && 'border-transparent text-muted-foreground/70 line-through',
                  )}
                >
                  #{d.number}
                </span>
              </Tip>
            );
          })}
        </span>
      )}
    </div>
  );
}
