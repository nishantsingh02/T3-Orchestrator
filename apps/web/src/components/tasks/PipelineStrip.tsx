import { PIPELINE_LABELS, PIPELINE_STEPS, pipelineFor, type PipelineState, type TaskView } from '@t3-orchestra/shared';
import { Fragment } from 'react';
import { cn } from '@/lib/utils';
import { LANE_STYLE, laneFor } from '@/lib/stage';

function Dot({ state, animate, tone }: { state: PipelineState; animate: boolean; tone: string }) {
  if (state === 'done') return <span className="size-[7px] shrink-0 rounded-full bg-muted-foreground/70" />;
  if (state === 'current') {
    return (
      <span
        className={cn(
          'size-[7px] shrink-0 rounded-full border border-current bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)]',
          tone,
          animate && 'animate-pulse-dot',
        )}
      />
    );
  }
  return <span className="size-[7px] shrink-0 rounded-full border border-muted-foreground/40" />;
}

/** ● Plan ● Build ◐ AI review r2 ○ Human ○ Done (spec §6.4). */
export function PipelineStrip({ task, compact = false }: { task: TaskView; compact?: boolean }) {
  const steps = pipelineFor(task);
  const lane = laneFor(task);
  const active =
    task.attention === null &&
    task.activeRun !== null &&
    (task.activeRun.status === 'active' || task.activeRun.status === 'starting');
  const tone = LANE_STYLE[lane].text;

  return (
    <div className="flex min-w-0 items-center" aria-label="Progress">
      {PIPELINE_STEPS.map((step, i) => {
        const state = steps[step];
        const label =
          step === 'ai_review' && task.reviewRound > 0
            ? `${compact ? 'AI' : PIPELINE_LABELS[step]} r${task.reviewRound}`
            : compact && step === 'ai_review'
              ? 'AI'
              : PIPELINE_LABELS[step];
        return (
          <Fragment key={step}>
            {i > 0 && (
              <span
                className={cn('mx-1 h-px min-w-1 flex-1', state === 'todo' ? 'bg-border' : 'bg-muted-foreground/40')}
              />
            )}
            <span className="flex shrink-0 items-center gap-1">
              <Dot state={state} animate={state === 'current' && active} tone={tone} />
              <span
                className={cn(
                  'text-[10px] leading-none',
                  state === 'current' && cn('font-medium', tone),
                  state === 'done' && 'text-muted-foreground',
                  state === 'todo' && 'text-muted-foreground/50',
                )}
              >
                {label}
              </span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
