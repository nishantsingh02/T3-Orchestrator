import type { EventView, RunStatus, RunView, TaskDetailView } from '@t3-orchestra/shared';
import { Bot, ChevronDown, ChevronRight, ExternalLink, Info, Sparkles } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Markdown } from '@/components/Markdown';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Elapsed } from '@/components/tasks/StatusLine';
import { describeEvent } from '@/lib/events';
import { RUN_KIND_LABELS } from '@/lib/stage';
import { absoluteTime, formatDuration, relativeTime, toMs } from '@/lib/time';
import { cn } from '@/lib/utils';

const RUN_STATUS_VARIANT: Record<RunStatus, BadgeProps['variant']> = {
  starting: 'primary',
  active: 'primary',
  waiting: 'warning',
  completed: 'success',
  failed: 'destructive',
  interrupted: 'destructive',
  cancelled: 'default',
  lost: 'destructive',
};

const OPEN_STATUSES: ReadonlySet<RunStatus> = new Set(['starting', 'active', 'waiting']);

function runTitle(r: RunView): string {
  if (r.kind === 'review') return `AI review${r.round ? ` · round ${r.round}` : ''}`;
  if (r.kind === 'fix') return `Fix round ${r.round ?? ''}`.trim();
  return RUN_KIND_LABELS[r.kind] ?? r.kind;
}

function Collapsible({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {label}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

function RawBlock({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const LIMIT = 6000;
  const long = text.length > LIMIT;
  return (
    <div>
      <pre className="max-h-96 overflow-auto rounded-md border border-border bg-surface p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap scrollbar-thin">
        {all || !long ? text : `${text.slice(0, LIMIT)}…`}
      </pre>
      {long && (
        <button type="button" className="mt-1 text-xs text-primary hover:underline" onClick={() => setAll((a) => !a)}>
          {all ? 'Show less' : `Show more (${Math.round(text.length / 1000)}k chars)`}
        </button>
      )}
    </div>
  );
}

function RunItem({ run }: { run: RunView }) {
  const open = OPEN_STATUSES.has(run.status);
  const started = toMs(run.startedAt);
  const finished = toMs(run.finishedAt);
  return (
    <li className="relative pl-6">
      <span
        className={cn(
          'absolute top-1 left-0 grid size-4 place-content-center rounded-full border bg-background',
          run.threadRole === 'review' ? 'border-stage-ai-review/50 text-stage-ai-review' : 'border-stage-running/50 text-stage-running',
        )}
      >
        {run.threadRole === 'review' ? <Sparkles className="size-2.5" /> : <Bot className="size-2.5" />}
      </span>
      <div className="rounded-md border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium">{runTitle(run)}</span>
          <Badge variant={RUN_STATUS_VARIANT[run.status]}>{run.status}</Badge>
          {run.external && (
            <Badge variant="outline" title="Started in T3 directly, not by T3 Orchestra">
              external
            </Badge>
          )}
          <span className="text-xs text-muted-foreground tabular" title={absoluteTime(run.startedAt)}>
            {relativeTime(run.startedAt)} ·{' '}
            {open ? <Elapsed since={run.startedAt} /> : started !== null && finished !== null ? formatDuration(finished - started) : '—'}
          </span>
          {run.threadLink && (
            <a
              href={run.threadLink}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Thread <ExternalLink className="size-3" />
            </a>
          )}
        </div>
        {run.summary && <Markdown className="mt-2 text-[13px]">{run.summary}</Markdown>}
        {run.error && (
          <p className="mt-2 rounded border border-destructive/30 bg-destructive/8 px-2 py-1 font-mono text-[11.5px] whitespace-pre-wrap text-destructive">
            {run.error}
          </p>
        )}
        {(run.resultRaw || run.promptText) && (
          <div className="mt-2 flex flex-col gap-1.5">
            {run.resultRaw && (
              <Collapsible label="Full last message">
                <RawBlock text={run.resultRaw} />
              </Collapsible>
            )}
            {run.promptText && (
              <Collapsible label="Prompt sent">
                <RawBlock text={run.promptText} />
              </Collapsible>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

const TONE: Record<string, string> = {
  default: 'bg-border-strong',
  good: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-destructive',
};

function EventItem({ event }: { event: EventView }) {
  const d = describeEvent(event);
  return (
    <li className="relative flex items-baseline gap-2 pl-6 text-xs">
      <span className={cn('absolute top-[5px] left-[5px] size-1.5 rounded-full', TONE[d.tone])} />
      <span className={cn('text-foreground/85', d.tone === 'bad' && 'text-destructive')}>{d.text}</span>
      {d.detail && <span className="min-w-0 truncate text-muted-foreground" title={d.detail}>{d.detail}</span>}
      <span className="ml-auto shrink-0 text-muted-foreground/80 tabular" title={absoluteTime(event.createdAt)}>
        {relativeTime(event.createdAt)}
      </span>
    </li>
  );
}

type Item = { kind: 'run'; at: number; run: RunView } | { kind: 'event'; at: number; event: EventView };

export function ActivityTab({ task }: { task: TaskDetailView | null }) {
  const items = useMemo<Item[]>(() => {
    if (!task) return [];
    const out: Item[] = [
      ...task.runs.map((run) => ({ kind: 'run' as const, at: toMs(run.startedAt) ?? 0, run })),
      ...task.events.map((event) => ({ kind: 'event' as const, at: toMs(event.createdAt) ?? 0, event })),
    ];
    return out.sort((a, b) => b.at - a.at);
  }, [task]);

  if (!task) return <p className="text-[13px] text-muted-foreground">Loading activity…</p>;

  return (
    <div className="flex flex-col gap-4">
      {task.activitySinceReview && (
        <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/8 p-2.5 text-xs">
          <Info className="mt-px size-3.5 shrink-0 text-info" />
          <span>
            <span className="font-medium text-info">Agent activity since review.</span>{' '}
            <span className="text-muted-foreground">
              The thread ran again after the task left implementation (e.g. you chatted with it in T3). The diff was
              re-read.
            </span>
          </span>
        </div>
      )}
      {items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No activity yet. Runs and stage changes show up here.</p>
      ) : (
        <ol className="relative flex flex-col gap-3 before:absolute before:top-2 before:bottom-2 before:left-[7.5px] before:w-px before:bg-border">
          {items.map((it) =>
            it.kind === 'run' ? <RunItem key={`r:${it.run.id}`} run={it.run} /> : <EventItem key={`e:${it.event.id}`} event={it.event} />,
          )}
        </ol>
      )}
    </div>
  );
}
