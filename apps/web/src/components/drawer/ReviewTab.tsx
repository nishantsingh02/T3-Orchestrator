import { SEVERITIES, SEVERITY_RANK, type BoardView, type FindingView, type Severity, type TaskDetailView, type TaskView } from '@t3-orchestra/shared';
import { CircleCheck, FileCode, ListPlus, TriangleExclamationPoint, X } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useAddFollowUp } from '@/api/tasks';
import { useBoardContext } from '@/components/board/BoardContext';
import { DesignSection } from '@/components/design/DesignSection';
import { Markdown } from '@/components/Markdown';
import { useActionPending, type useTaskActions } from '@/components/tasks/useTaskActions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton, Spinner } from '@/components/ui/spinner';
import { DiffStatText, openFindingsText, ReviewScore } from '@/components/tasks/StatusLine';
import { reasonLabel, SEVERITY_STYLE } from '@/lib/stage';
import { cn } from '@/lib/utils';
import { SectionTitle } from './OverviewTab';
import { Screenshots } from './Screenshots';
import { StageActions } from './StageActions';

type Run = ReturnType<typeof useTaskActions>['run'];

// diff2html is heavy; load it with the Review tab.
const DiffViewer = lazy(() => import('./DiffViewer').then((m) => ({ default: m.DiffViewer })));

/** The text up to the first sentence end; results written before `tldr` existed fall back to it. */
function firstSentence(text: string): string {
  const t = text.trim();
  return /^[\s\S]*?[.!?](?=\s|$)/.exec(t)?.[0] ?? t;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Why the latest passing review's auto-approve did not go through, if it was tried. */
function autoApproveError(detail: TaskDetailView | null): string | null {
  const events = [...(detail?.events ?? [])].reverse();
  const pass = events.find((e) => e.type === 'stage_changed' && e.payload.event === 'review.pass');
  const failed = pass && events.find((e) => e.type === 'auto_approve_failed' && e.runId === pass.runId);
  return failed ? String(failed.payload.message ?? 'unknown error') : null;
}

/** The reviewer's score and why, plus the reason when an auto-approve attempt failed. */
function ScoreRow({ task, detail }: { task: TaskView; detail: TaskDetailView | null }) {
  if (task.reviewScore === null) return null;
  const failed = task.stage === 'human_review' ? autoApproveError(detail) : null;
  return (
    <div className="flex flex-col gap-0.5 text-[12.5px]">
      <p>
        <ReviewScore task={task} className="font-medium" />
        {task.reviewScoreReason && <span className="text-muted-foreground"> · {task.reviewScoreReason}</span>}
      </p>
      {failed && <p className="text-[11.5px] text-warning">Auto-approve failed: {failed}</p>}
    </div>
  );
}

/** A few lines to read first: the agent's tldr, the review score, the key numbers, and any screenshots. */
function GlanceSection({ task, detail }: { task: TaskView; detail: TaskDetailView | null }) {
  const result = detail?.lastResult ?? null;
  const shots = detail?.screenshots ?? [];
  const headline = result?.tldr?.trim() || firstSentence(result?.summary ?? task.lastSummary ?? '');
  if (!headline && shots.length === 0 && task.reviewScore === null) return null;

  const openFindings = openFindingsText(task.findings, true);
  const facts = [
    task.diffStat && <DiffStatText key="diff" stat={task.diffStat} className="text-[11.5px]" />,
    result && result.testsRun.length > 0 && `${plural(result.testsRun.length, 'check')} run`,
    task.stageReason === 'ai_review_skipped'
      ? 'AI review skipped'
      : task.reviewRound > 0 && (openFindings ? `${openFindings} open` : 'no open findings'),
    result && result.followUps.length > 0 && plural(result.followUps.length, 'follow-up'),
    shots.length > 0 && plural(shots.length, 'screenshot'),
  ].filter(Boolean);

  return (
    <section>
      <SectionTitle action={result?.status === 'blocked' ? <Badge variant="destructive">blocked</Badge> : undefined}>
        At a glance
      </SectionTitle>
      <div className="flex flex-col gap-2.5 rounded-md border border-border bg-surface p-3">
        {headline && <Markdown className="line-clamp-4 text-[13.5px] leading-relaxed">{headline}</Markdown>}
        <ScoreRow task={task} detail={detail} />
        {facts.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-muted-foreground">
            {facts.map((f, i) => (
              <span key={i} className="contents">
                {i > 0 && <span className="text-muted-foreground/50">·</span>}
                {f}
              </span>
            ))}
          </p>
        )}
        {shots.length > 0 && <Screenshots shots={shots} />}
      </div>
    </section>
  );
}

function ResultSection({ task, detail }: { task: TaskView; detail: TaskDetailView | null }) {
  const { tasks, openTask } = useBoardContext();
  const addFollowUp = useAddFollowUp();
  const result = detail?.lastResult ?? null;
  // Suggestions already on the board, by text; discarding the follow-up frees its suggestion again.
  const addedAs = useMemo(
    () =>
      new Map(tasks.filter((t) => t.followUpOf === task.id && t.stage !== 'discarded').map((t) => [t.followUpText, t])),
    [tasks, task.id],
  );

  if (!result) {
    return (
      <section>
        <SectionTitle>Implementer result</SectionTitle>
        {task.resultMissing ? (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-[13px] text-warning">
              <TriangleExclamationPoint className="size-3.5" />
              The agent finished without a structured result block.
            </p>
            {task.lastMessage && (
              <div className="rounded-md border border-border bg-surface p-3">
                <Markdown className="text-[13px]">{task.lastMessage}</Markdown>
              </div>
            )}
          </div>
        ) : task.lastSummary ? (
          <Markdown className="text-[13px]">{task.lastSummary}</Markdown>
        ) : (
          <p className="text-[13px] text-muted-foreground">No result yet.</p>
        )}
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle
        action={
          result.status === 'blocked' ? (
            <Badge variant="destructive">blocked</Badge>
          ) : (
            <Badge variant="success">
              <CircleCheck />
              done
            </Badge>
          )
        }
      >
        Implementer result
      </SectionTitle>
      <Markdown className="text-[13px]">{result.summary}</Markdown>
      {result.blockedReason && (
        <p className="rounded-md border border-destructive/30 bg-destructive/8 p-2 text-[13px] text-destructive">
          {result.blockedReason}
        </p>
      )}
      {result.changes.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">Changes</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
            {result.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {result.testsRun.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">Tests run</h4>
          <ul className="space-y-0.5">
            {result.testsRun.map((t, i) => (
              <li key={i} className="rounded bg-surface px-2 py-1 font-mono text-[11.5px]">
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.followUps.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">Suggested follow-ups</h4>
          <ul className="divide-y divide-border rounded-md border border-border">
            {result.followUps.map((f, i) => {
              const existing = addedAs.get(f.trim());
              return (
                <li key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-[13px]">
                  <span className="min-w-0 flex-1">{f}</span>
                  {existing ? (
                    <Button size="xs" variant="ghost" title={`Open #${existing.number}`} onClick={() => openTask(existing)}>
                      <CircleCheck className="text-success" />
                      Added as #{existing.number}
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={addFollowUp.isPending && addFollowUp.variables?.text === f}
                      onClick={() => addFollowUp.mutate({ taskId: task.id, text: f })}
                    >
                      <ListPlus />
                      Add as task
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function FindingCard({ finding, task, run }: { finding: FindingView; task: TaskView; run: Run }) {
  const dismissing = useActionPending(task.id, 'dismiss-finding');
  const closed = finding.status !== 'open';
  return (
    <li className={cn('rounded-md border border-border bg-card p-3', closed && 'opacity-60')}>
      <div className="flex items-start gap-2">
        <span className={cn('rounded-[4px] border px-1.5 py-0.5 text-[10.5px] leading-none font-medium uppercase', SEVERITY_STYLE[finding.severity])}>
          {finding.severity}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn('text-[13px] leading-snug font-medium', closed && 'line-through')}>{finding.title}</p>
          {finding.file && (
            <p className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
              <FileCode className="size-3" />
              {finding.file}
              {finding.line !== null && `:${finding.line}`}
            </p>
          )}
        </div>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">r{finding.round}</span>
        {closed ? (
          <Badge variant={finding.status === 'addressed' ? 'success' : 'default'}>{finding.status}</Badge>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            disabled={dismissing}
            onClick={() => void run(task, 'dismiss-finding', { findingId: finding.id }, { noOptimistic: true })}
          >
            {dismissing ? <Spinner className="size-3" /> : <X />}
            Dismiss
          </Button>
        )}
      </div>
      {finding.detail && <Markdown className="mt-2 text-[13px] text-foreground/90">{finding.detail}</Markdown>}
      {finding.suggestion && (
        <div className="mt-2 rounded border-l-2 border-primary/50 bg-primary/5 px-2.5 py-1.5 text-[12.5px]">
          <span className="text-xs font-medium text-muted-foreground">Suggested: </span>
          <Markdown className="inline [&>p]:inline">{finding.suggestion}</Markdown>
        </div>
      )}
    </li>
  );
}

function FindingsSection({ task, detail, run }: { task: TaskView; detail: TaskDetailView | null; run: Run }) {
  const findings = detail?.findingsList ?? [];
  const [hidden, setHidden] = useState<Set<Severity>>(new Set());
  const [openOnly, setOpenOnly] = useState(false);

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
    for (const f of findings) c[f.severity]++;
    return c;
  }, [findings]);

  const groups = useMemo(() => {
    const visible = findings
      .filter((f) => !hidden.has(f.severity) && (!openOnly || f.status === 'open'))
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.round - a.round);
    return SEVERITIES.map((s) => ({ severity: s, items: visible.filter((f) => f.severity === s) })).filter(
      (g) => g.items.length > 0,
    );
  }, [findings, hidden, openOnly]);

  const reviewed = task.reviewRound > 0 || findings.length > 0;

  return (
    <section>
      <SectionTitle
        action={
          task.stageReason && ['ai_passed', 'ai_unresolved', 'review_failed', 'ai_review_skipped'].includes(task.stageReason) ? (
            <Badge
              variant={
                task.stageReason === 'ai_passed' ? 'success' : task.stageReason === 'ai_review_skipped' ? 'default' : 'warning'
              }
            >
              {reasonLabel(task.stageReason)}
            </Badge>
          ) : undefined
        }
      >
        AI findings
      </SectionTitle>
      {!reviewed ? (
        <p className="text-[13px] text-muted-foreground">No AI review yet.</p>
      ) : findings.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">The reviewer reported no findings.</p>
      ) : (
        <>
          <div className="mb-2.5 flex flex-wrap items-center gap-1">
            {SEVERITIES.map((s) => {
              const on = !hidden.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  disabled={counts[s] === 0}
                  onClick={() =>
                    setHidden((h) => {
                      const next = new Set(h);
                      if (next.has(s)) next.delete(s);
                      else next.add(s);
                      return next;
                    })
                  }
                  className={cn(
                    'inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs transition-colors disabled:opacity-40',
                    on && counts[s] > 0 ? SEVERITY_STYLE[s] : 'border-border text-muted-foreground',
                  )}
                  aria-pressed={on}
                >
                  {s}
                  <span className="font-mono text-[10.5px] tabular">{counts[s]}</span>
                </button>
              );
            })}
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} className="accent-primary" />
              Open only
            </label>
          </div>
          {groups.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No findings match the filter.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map((g) => (
                <ul key={g.severity} className="flex flex-col gap-1.5">
                  {g.items.map((f) => (
                    <FindingCard key={f.id} finding={f} task={task} run={run} />
                  ))}
                </ul>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function ReviewTab({
  task,
  detail,
  board,
  run,
}: {
  task: TaskView;
  detail: TaskDetailView | null;
  board: BoardView;
  run: Run;
}) {
  return (
    <div className="flex flex-col gap-7">
      <DesignSection task={task} detail={detail} />
      <GlanceSection task={task} detail={detail} />
      <ResultSection task={task} detail={detail} />
      <FindingsSection task={task} detail={detail} run={run} />
      <section>
        <SectionTitle>Changes</SectionTitle>
        <Suspense fallback={<Skeleton className="h-40" />}>
          <DiffViewer task={task} />
        </Suspense>
      </section>
      {task.stage === 'human_review' && (
        <section>
          <SectionTitle>Decide</SectionTitle>
          <StageActions task={task} board={board} run={run} expanded />
        </section>
      )}
    </div>
  );
}
