import { holdReason, SEVERITIES, type BoardView, type FindingCounts, type TaskView } from '@t3-orchestra/shared';
import type { ReactNode } from 'react';
import { Tip } from '@/components/ui/tooltip';
import { ATTENTION_LABELS, laneFor, reasonLabel, RUN_KIND_LABELS } from '@/lib/stage';
import { formatDuration, relativeTime, toMs, useNow } from '@/lib/time';
import { cn, firstLine } from '@/lib/utils';

export function Elapsed({ since }: { since: string | null | undefined }) {
  const now = useNow();
  const t = toMs(since);
  if (t === null) return null;
  return <span className="tabular">{formatDuration(now - t)}</span>;
}

/** "1 blocker, 2 major" from open finding counts (nits left out). */
export function openFindingsText(f: FindingCounts, includeNits = false): string {
  return SEVERITIES.filter((s) => (includeNits || s !== 'nit') && (f.open[s] ?? 0) > 0)
    .map((s) => `${f.open[s]} ${s}`)
    .join(', ');
}

export function DiffStatText({ stat, className }: { stat: TaskView['diffStat']; className?: string }) {
  if (!stat) return null;
  return (
    <span className={cn('font-mono text-[10.5px] tabular', className)}>
      <span className="text-success">+{stat.added}</span> <span className="text-destructive">−{stat.removed}</span>
      <span className="text-muted-foreground"> · {stat.files} {stat.files === 1 ? 'file' : 'files'}</span>
    </span>
  );
}

/** The AI reviewer's 1-10 "how much does this need you" score, e.g. "review 4/10". */
export function ReviewScore({ task, className }: { task: Pick<TaskView, 'reviewScore' | 'reviewScoreReason'>; className?: string }) {
  const s = task.reviewScore;
  if (s === null) return null;
  const tone = s >= 9 ? 'text-destructive' : s >= 7 ? 'text-warning' : s >= 4 ? 'text-foreground/85' : 'text-muted-foreground';
  const why = task.reviewScoreReason ? `\n${task.reviewScoreReason}` : '';
  return (
    <span className={cn('tabular', tone, className)} title={`AI review score: how much this needs your review (1-10).${why}`}>
      review {s}/10
    </span>
  );
}

/** Tooltip for a task held back by "Avoid overlapping work". */
export function overlapWhy(numbers: readonly number[], paths: readonly string[]): string {
  const nums = numbers.map((n) => `#${n}`).join(' ');
  return `"Avoid overlapping work" is on, so this waits until ${nums} ${numbers.length === 1 ? 'is' : 'are'} past AI review. Shared: ${paths.join(', ')}. Turn the setting off in board settings to run them side by side.`;
}

const Sep = () => <span className="text-muted-foreground/50">·</span>;

function Line({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] leading-4', className)}>
      {children}
    </div>
  );
}

function runActivity(task: TaskView) {
  const run = task.activeRun;
  return (
    <>
      {run && (
        <>
          <Sep />
          <Elapsed since={run.startedAt} />
          {run.events > 0 && (
            <>
              <Sep />
              <span className="tabular">{run.events} events</span>
            </>
          )}
          {run.background.length > 0 && (
            <>
              <Sep />
              <span
                className="min-w-0 truncate text-info"
                title={`The agent's turn ended while this still runs: ${run.background.join(', ')}. T3 resumes the agent when it is done, and the board waits for that.`}
              >
                waiting on {run.background[0]}
                {run.background.length > 1 && ` +${run.background.length - 1}`}
              </span>
            </>
          )}
        </>
      )}
      {task.quietMinutes !== null && (
        <span className="text-muted-foreground/70" title="No thread activity for a while (information only)">
          quiet for {formatDuration(task.quietMinutes * 60_000)}
        </span>
      )}
    </>
  );
}

interface Props {
  task: TaskView;
  board: BoardView;
  /** Tasks holding a slot (implementing + ai_review). */
  activeTasks: TaskView[];
  pauseAll: boolean;
}

/** The column-specific status line under the pipeline strip (spec §14.2). */
export function StatusLine({ task, board, activeTasks, pauseAll }: Props) {
  const lane = laneFor(task);

  switch (lane) {
    case 'backlog':
    case 'ready': {
      // Mirrors the scheduler, so a held-back task doesn't just say "Ready".
      const hold = holdReason(task, board, activeTasks, pauseAll);
      switch (hold?.kind) {
        case 'blocked':
          return (
            <Line className="text-destructive">
              Blocked by {hold.deps.map((d) => `#${d.number} (${d.stage})`).join(', ')}
            </Line>
          );
        case 'waiting':
          return (
            <Line className="text-muted-foreground">
              Waiting for <span className="font-mono">{hold.deps.map((d) => `#${d.number}`).join(' ')}</span>
            </Line>
          );
        case 'auto_run_off':
          return <Line className="text-muted-foreground">Auto-run off</Line>;
        case 'paused':
          return <Line className="text-warning">Paused (all boards)</Line>;
        case 'no_slot':
          return (
            <Line className="text-muted-foreground">
              Waiting for slot ({hold.active}/{hold.max})
            </Line>
          );
        case 'overlap':
          return (
            <Tip content={overlapWhy(hold.tasks, hold.paths)}>
              <div className="min-w-0">
                <Line className="text-muted-foreground">
                  <span>
                    Overlaps <span className="font-mono">{hold.tasks.map((n) => `#${n}`).join(' ')}</span>
                  </span>
                  <Sep />
                  <span className="min-w-0 truncate font-mono">{hold.paths[0]}</span>
                  {hold.paths.length > 1 && <span>+{hold.paths.length - 1}</span>}
                </Line>
              </div>
            </Tip>
          );
        case 'ready':
          return <Line className="text-stage-ready">Ready</Line>;
        default:
          return null;
      }
    }

    case 'running': {
      const run = task.activeRun;
      if (!run) return <Line className="text-muted-foreground">Starting…</Line>;
      const label =
        run.kind === 'fix'
          ? `Fix round ${run.round ?? task.fixRound}`
          : (RUN_KIND_LABELS[run.kind] ?? run.kind);
      return (
        <Line className="text-muted-foreground">
          <span className="text-foreground/85">{label}</span>
          {runActivity(task)}
        </Line>
      );
    }

    case 'ai_review': {
      const round = task.activeRun?.round ?? task.reviewRound;
      return (
        <Line className="text-muted-foreground">
          <span className="text-foreground/85">Review round {round || 1}</span>
          {runActivity(task)}
        </Line>
      );
    }

    case 'needs_input':
      return (
        <Line className="font-medium text-stage-needs-input">
          {task.attention ? ATTENTION_LABELS[task.attention] : 'Waiting'}
          {task.stage === 'ai_review' && <span className="font-normal text-muted-foreground">· reviewer</span>}
        </Line>
      );

    case 'human_review': {
      const open = openFindingsText(task.findings);
      let verdict: ReactNode;
      switch (task.stageReason) {
        case 'ai_passed':
          verdict = (
            <span className="text-success">
              ✓ AI passed{open && <span className="text-muted-foreground"> · {open}</span>}
            </span>
          );
          break;
        case 'ai_unresolved':
          verdict = <span className="text-warning">⚠ {open || 'findings'} unresolved</span>;
          break;
        case 'review_failed':
          verdict = <span className="text-warning">⚠ AI review failed</span>;
          break;
        case 'merge_conflict':
          verdict = <span className="text-destructive">⚠ Merge conflict</span>;
          break;
        case 'ai_review_skipped':
          verdict = <span className="text-muted-foreground">AI review skipped</span>;
          break;
        case 'pr_opened':
          verdict = <span className="text-info">PR opened</span>;
          break;
        case 'design_options':
          verdict = (
            <span className="font-medium text-stage-human-review">
              Pick a design
              {task.design && (
                <span className="font-normal text-muted-foreground">
                  {' '}
                  · {task.design.options} options{task.design.round > 1 && `, round ${task.design.round}`}
                </span>
              )}
            </span>
          );
          break;
        default:
          verdict = <span className="text-muted-foreground">Ready for review</span>;
      }
      return (
        <div className="flex flex-col gap-0.5">
          <Line>
            {verdict}
            {task.reviewScore !== null && (
              <>
                <Sep />
                <ReviewScore task={task} />
              </>
            )}
            {task.diffStat && (
              <>
                <Sep />
                <DiffStatText stat={task.diffStat} />
              </>
            )}
          </Line>
          {(task.activitySinceReview || task.resultMissing) && (
            <Line className="text-muted-foreground/80">
              {task.activitySinceReview && <span>agent activity since review</span>}
              {task.activitySinceReview && task.resultMissing && <Sep />}
              {task.resultMissing && <span>no structured result</span>}
            </Line>
          )}
        </div>
      );
    }

    case 'done':
      return (
        <Line className="text-muted-foreground">
          <span className="text-success">Done</span>
          {task.stageReason === 'auto_approved' && (
            <>
              <Sep />
              <span title={task.reviewScoreReason ?? undefined}>
                auto-approved{task.reviewScore !== null && ` (${task.reviewScore}/10)`}
              </span>
            </>
          )}
          {task.completedAt && (
            <>
              <Sep />
              <span>{relativeTime(task.completedAt)}</span>
            </>
          )}
          {task.diffStat && (
            <>
              <Sep />
              <DiffStatText stat={task.diffStat} />
            </>
          )}
        </Line>
      );

    case 'failed': {
      const msg = firstLine(task.lastMessage);
      return (
        <div className="flex min-w-0 flex-col gap-0.5">
          <Line className="font-medium text-destructive">{reasonLabel(task.stageReason) ?? 'Failed'}</Line>
          {msg && <p className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">{msg}</p>}
        </div>
      );
    }

    case 'discarded':
      return <Line className="text-muted-foreground">Discarded</Line>;
  }
}
