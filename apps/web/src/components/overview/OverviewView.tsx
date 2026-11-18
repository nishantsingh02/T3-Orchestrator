import { useQueryClient } from '@tanstack/react-query';
import {
  boardOverview,
  COLUMN_ORDER,
  holdReason,
  type BoardStatsView,
  type BoardView,
  type HoldKind,
  type PlanView,
  type RunKind,
  type ScopeGroup,
  type TaskView,
} from '@t3-orchestra/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useBoardStats } from '@/api/boards';
import { keys } from '@/api/keys';
import { useBoardPlans } from '@/api/plans';
import { useBoardContext } from '@/components/board/BoardContext';
import { planPath, planTitle } from '@/components/plans/model';
import { Elapsed, overlapWhy, ReviewScore } from '@/components/tasks/StatusLine';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { ATTENTION_LABELS, LANE_LABELS, LANE_STYLE, laneFor, reasonLabel, RUN_KIND_LABELS } from '@/lib/stage';
import { formatDuration } from '@/lib/time';
import { cn } from '@/lib/utils';
import { ChartLegend, DailyChart, DailyTable } from './DailyChart';
import { Card, Empty, Meter, plural, RowList, StatTile, TaskRow } from './parts';

function etaText(etaDays: number | null, windowDays: number): string {
  if (etaDays === 0) return 'All done';
  if (etaDays === null) return `Nothing finished in the last ${plural(windowDays, 'day')}`;
  if (etaDays < 1) return 'Under a day at this pace';
  return `About ${plural(Math.round(etaDays), 'day')} at this pace`;
}

// ---- sections ----------------------------------------------------------------------

function Progress({ total, done, byColumn }: { total: number; done: number; byColumn: Record<string, number> }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const parts = COLUMN_ORDER.filter((c) => (byColumn[c] ?? 0) > 0);
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:gap-6">
      <div className="flex shrink-0 items-baseline gap-2">
        <span className="text-[44px] leading-none font-semibold tracking-tight">{pct}%</span>
        <span className="text-[13px] text-muted-foreground">
          {done} of {plural(total, 'task')} done
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {total === 0 ? (
          <div className="h-2.5 rounded-full bg-muted" />
        ) : (
          <div className="flex h-2.5 gap-[2px]" role="img" aria-label="Tasks by column">
            {parts.map((c, i) => (
              <Tip key={c} content={`${LANE_LABELS[c]}: ${byColumn[c]}`}>
                <span
                  className={cn(
                    'h-full min-w-[3px]',
                    LANE_STYLE[c].dot,
                    i === 0 && 'rounded-l-full',
                    i === parts.length - 1 && 'rounded-r-full',
                  )}
                  style={{ flexGrow: byColumn[c] }}
                />
              </Tip>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {parts.map((c) => (
            <span key={c} className="flex items-center gap-1.5">
              <span className={cn('size-2 rounded-[2px]', LANE_STYLE[c].dot)} />
              {LANE_LABELS[c]}
              <span className="text-foreground tabular">{byColumn[c]}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function ScopeCard({ scope, plans, board }: { scope: ScopeGroup[]; plans: PlanView[]; board: BoardView }) {
  return (
    <Card title="Scope" subtitle="Tasks from each plan, and the follow-ups agents suggested along the way">
      {scope.length === 0 ? (
        <Empty>No tasks yet. Start with a plan or a task.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {scope.map((g) => {
            const plan = plans.find((p) => p.id === g.planId);
            const growth = g.planned.total ? Math.round((g.followUps.total / g.planned.total) * 100) : null;
            return (
              <div key={g.planId ?? 'manual'} className="flex flex-col gap-2">
                <div className="flex min-w-0 items-baseline gap-2 text-[12.5px]">
                  {g.planId ? (
                    <>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">P{plan?.number ?? '?'}</span>
                      <Link to={planPath(board.slug, g.planId)} className="min-w-0 truncate font-medium hover:underline">
                        {planTitle(plan)}
                      </Link>
                    </>
                  ) : (
                    <span className="font-medium">Added by hand</span>
                  )}
                </div>
                {g.planned.total > 0 && <Meter label={g.planId ? 'Planned' : 'Tasks'} {...g.planned} />}
                {g.followUps.total > 0 && <Meter label="Follow-ups" {...g.followUps} />}
                {g.followUps.total > 0 && growth !== null && (
                  <p className="text-xs text-muted-foreground">
                    Follow-ups added {plural(g.followUps.total, 'task')} ({growth}% on top of the{' '}
                    {g.planId ? 'plan' : 'hand-added tasks'}).
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

const HOLD_COPY: Record<HoldKind, { title: string; note?: string }> = {
  ready: { title: 'Starting next', note: 'Auto-run picks these up on its next pass.' },
  no_slot: { title: 'Waiting for a free slot', note: 'Raise Parallel in the toolbar to run more at once.' },
  overlap: {
    title: 'Held back by overlapping work',
    note: 'They touch the same paths as tasks still running ("Avoid overlapping work" in board settings).',
  },
  waiting: { title: 'Waiting on other tasks' },
  blocked: { title: 'Blocked by a failed or discarded task' },
  auto_run_off: { title: 'Auto-run is off', note: 'Start them by hand, or turn on Auto-run.' },
  paused: { title: 'Paused on all boards', note: 'Resume from the global settings.' },
  backlog: { title: 'In Backlog', note: 'Auto-run only picks up Ready tasks.' },
};

function HoldsCard({ overview }: { overview: ReturnType<typeof boardOverview> }) {
  const { board, activeTasks, pauseAll } = useBoardContext();
  const meta = (t: TaskView): ReactNode => {
    const r = holdReason(t, board, activeTasks, pauseAll);
    if (!r) return null;
    if (r.kind === 'waiting' || r.kind === 'blocked') return <span className="font-mono">after {r.deps.map((d) => `#${d.number}`).join(' ')}</span>;
    if (r.kind === 'overlap') {
      return (
        <Tip content={overlapWhy(r.tasks, r.paths)}>
          <span className="max-w-48 truncate font-mono">{r.paths[0]}</span>
        </Tip>
      );
    }
    return null;
  };
  return (
    <Card title="What's holding work back" subtitle="Backlog and Ready tasks, grouped by why they aren't running">
      {overview.holds.length === 0 ? (
        <Empty>Nothing is waiting to start.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {overview.holds.map((h) => (
            <div key={h.kind} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <h3 className="text-[12.5px] font-medium">{HOLD_COPY[h.kind].title}</h3>
                <span className="text-xs text-muted-foreground tabular">{h.tasks.length}</span>
              </div>
              {HOLD_COPY[h.kind].note && <p className="text-xs text-muted-foreground">{HOLD_COPY[h.kind].note}</p>}
              <RowList items={h.tasks} render={(t) => <TaskRow key={t.id} task={t} meta={meta(t)} />} />
            </div>
          ))}
        </div>
      )}
      {overview.unblockers.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <h3 className="text-[12.5px] font-medium">Finishing these opens up the most</h3>
          <ul className="-mx-2 flex flex-col">
            {overview.unblockers.map((u) => (
              <TaskRow
                key={u.task.id}
                task={u.task}
                meta={
                  <>
                    <span className="text-foreground tabular">{u.waiting}</span> waiting · {LANE_LABELS[laneFor(u.task)]}
                  </>
                }
              />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function needsYouMeta(t: TaskView): ReactNode {
  const lane = laneFor(t);
  if (lane === 'needs_input') return t.attention ? ATTENTION_LABELS[t.attention] : 'Waiting';
  if (lane === 'failed') return <span className="text-destructive">{reasonLabel(t.stageReason) ?? 'Failed'}</span>;
  return (
    <>
      {reasonLabel(t.stageReason) ?? 'Ready for review'}
      {t.reviewScore !== null && (
        <>
          {' · '}
          <ReviewScore task={t} />
        </>
      )}
    </>
  );
}

function NowCard({ overview }: { overview: ReturnType<typeof boardOverview> }) {
  return (
    <Card title="Now" subtitle="What needs you, and what the agents are working on">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-baseline gap-2 text-[12.5px] font-medium">
          Needs you <span className="text-xs font-normal text-muted-foreground tabular">{overview.needsYou.length}</span>
        </h3>
        {overview.needsYou.length === 0 ? (
          <Empty>Nothing needs you right now.</Empty>
        ) : (
          <RowList items={overview.needsYou} render={(t) => <TaskRow key={t.id} task={t} meta={needsYouMeta(t)} />} />
        )}
      </div>
      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <h3 className="flex items-baseline gap-2 text-[12.5px] font-medium">
          Running <span className="text-xs font-normal text-muted-foreground tabular">{overview.running.length}</span>
        </h3>
        {overview.running.length === 0 ? (
          <Empty>Nothing running.</Empty>
        ) : (
          <RowList
            items={overview.running}
            render={(t) => (
              <TaskRow
                key={t.id}
                task={t}
                meta={
                  t.activeRun && (
                    <>
                      {RUN_KIND_LABELS[t.activeRun.kind]} · <Elapsed since={t.activeRun.startedAt} />
                    </>
                  )
                }
              />
            )}
          />
        )}
      </div>
    </Card>
  );
}

const TIME_LABELS: Record<RunKind, string> = {
  spec: 'Spec drafting',
  plan: 'Planning',
  implement: 'Implementing',
  review: 'AI review',
  fix: 'Fix rounds',
  changes: 'Your changes',
  resume: 'Resuming',
  rebase: 'Branch updates',
  followup: 'Follow-up messages',
  pr: 'Opening PRs',
  design: 'Building chosen designs',
  options: 'Design options',
  insight: 'Insights answers',
  ideas: 'Idea generation',
  import: 'Imports from T3',
  security: 'Security audits',
  knowledge: 'Knowledge graph builds',
};

function Fact({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-border py-2 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular">{value}</span>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function TimeCard({ stats, overview }: { stats: BoardStatsView | undefined; overview: ReturnType<typeof boardOverview> }) {
  if (!stats) {
    return (
      <Card title="Where the time went">
        <Skeleton className="h-40" />
      </Card>
    );
  }
  const rows = [...stats.runs].sort((a, b) => b.totalMs - a.totalMs);
  const max = Math.max(1, ...rows.map((r) => r.totalMs));
  const rebase = stats.runs.find((r) => r.kind === 'rebase');
  const dur = (ms: number | null) => (ms === null ? '–' : formatDuration(ms));
  return (
    <Card title="Where the time went" subtitle="Agent time per kind of run, and time spent waiting on you">
      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-[3fr_2fr]">
        {rows.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {rows.map((r) => (
              <li key={r.kind} className="grid grid-cols-[112px_1fr_64px] items-center gap-3 text-xs">
                <span className="truncate text-muted-foreground">{TIME_LABELS[r.kind]}</span>
                <Tip
                  content={
                    <span>
                      {plural(r.runs, 'run')} · median {dur(r.medianMs)}
                      {r.failed > 0 && ` · ${r.failed} failed`}
                    </span>
                  }
                >
                  <div className="flex h-5 items-center gap-2">
                    <span
                      className="h-2 min-w-[2px] rounded-r-[4px] bg-stage-running"
                      style={{ width: `${(r.totalMs / max) * 70}%` }}
                    />
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular">
                      {plural(r.runs, 'run')}
                      {r.failed > 0 && <span className="text-destructive"> · {r.failed} failed</span>}
                    </span>
                  </div>
                </Tip>
                <span className="text-right font-medium tabular">{formatDuration(r.totalMs)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col">
          <Fact label="Start to done" value={dur(overview.cycleMs)} note="Median, from a task's first start to Done." />
          <Fact
            label="Waiting in Human Review"
            value={dur(stats.reviewWait.medianMs)}
            note={
              <>
                Median over {plural(stats.reviewWait.count, 'review')}
                {stats.reviewWait.open > 0 && `, ${stats.reviewWait.open} waiting now`}. Auto-approved tasks don't count.
              </>
            }
          />
          <Fact
            label="Agents waiting for your answer"
            value={dur(stats.answerWait.totalMs)}
            note={`${plural(stats.answerWait.count, 'time')} in total${stats.answerWait.open > 0 ? `, ${stats.answerWait.open} waiting now` : ''}.`}
          />
          <Fact
            label="Merge conflicts at approve"
            value={stats.mergeConflicts}
            note={
              stats.mergeConflicts > 0
                ? `Each one needs a branch update${rebase ? ` (${plural(rebase.runs, 'update')} so far, ${formatDuration(rebase.totalMs)})` : ''}.`
                : undefined
            }
          />
          <Fact label="Auto-approved" value={`${overview.autoApproved} of ${overview.done}`} note="Done tasks merged without you." />
        </div>
      </div>
    </Card>
  );
}

// ---- view --------------------------------------------------------------------------

export function OverviewView({ loading }: { loading: boolean }) {
  const { board, tasks, pauseAll } = useBoardContext();
  const plans = useBoardPlans(board.id).data ?? [];
  const stats = useBoardStats(board.id);
  const [table, setTable] = useState(false);

  const overview = useMemo(() => boardOverview(tasks, { board, pauseAll }), [tasks, board, pauseAll]);

  // Run and wait numbers come from the server: refetch them when a task changes stage or run.
  const qc = useQueryClient();
  const signature = useMemo(
    () => tasks.map((t) => `${t.id}:${t.stage}:${t.attention ?? ''}:${t.activeRun?.id ?? ''}`).join('|'),
    [tasks],
  );
  const seen = useRef(signature);
  useEffect(() => {
    if (seen.current === signature) return;
    seen.current = signature;
    void qc.invalidateQueries({ queryKey: keys.stats(board.id), exact: true });
  }, [signature, qc, board.id]);

  if (loading) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-3 p-3 sm:p-4">
        <Skeleton className="h-24" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const { pace } = overview;
  const agentMs = stats.data?.runs.reduce((s, r) => s + r.totalMs, 0) ?? null;
  const needs = overview.byColumn;
  const needsParts = [
    needs.needs_input && `${needs.needs_input} asking`,
    needs.human_review && `${needs.human_review} to review`,
    needs.failed && `${needs.failed} failed`,
  ].filter(Boolean);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 p-3 sm:p-4">
        <Progress total={overview.total} done={overview.done} byColumn={overview.byColumn} />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Left to do" value={overview.remaining} unit={overview.remaining === 1 ? 'task' : 'tasks'} note={etaText(pace.etaDays, pace.windowDays)} />
          <StatTile
            label="Pace"
            value={Number.isInteger(pace.perDay) ? pace.perDay : pace.perDay.toFixed(1)}
            unit="done / day"
            note={`${pace.done} done in the last ${plural(pace.windowDays, 'day')}`}
          />
          <StatTile
            label="Needs you"
            value={overview.needsYou.length}
            unit={overview.needsYou.length === 1 ? 'task' : 'tasks'}
            note={needsParts.length ? needsParts.join(' · ') : 'Nothing waiting on you'}
          />
          <StatTile
            label="Agent time"
            value={agentMs === null ? '–' : formatDuration(agentMs)}
            note={agentMs !== null && overview.done > 0 ? `About ${formatDuration(agentMs / overview.done)} per finished task` : 'All runs on this board'}
          />
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <ScopeCard scope={overview.scope} plans={plans} board={board} />
          <Card
            title="Done and added per day"
            subtitle="Scope grows when plans are accepted and follow-ups are added"
            actions={
              <Button variant="ghost" size="xs" onClick={() => setTable((v) => !v)} aria-pressed={table}>
                {table ? 'Chart' : 'Table'}
              </Button>
            }
          >
            {table ? <DailyTable days={overview.days} /> : <DailyChart days={overview.days} />}
            {!table && <ChartLegend />}
          </Card>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <HoldsCard overview={overview} />
          <NowCard overview={overview} />
        </div>

        <TimeCard stats={stats.data} overview={overview} />
      </div>
    </div>
  );
}
