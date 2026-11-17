// The findings list: by status (open, on the board, fixed, dismissed), narrowed by severity, source
// and a search. Shared by the Findings section and the two scan sections.
import {
  findingRef,
  SECURITY_DISMISS_LABELS,
  SECURITY_SEVERITIES,
  SECURITY_SOURCES,
  type SecurityFindingStatus,
  type SecurityFindingView,
  type SecuritySeverity,
  type SecuritySource,
} from '@t3-orchestra/shared';
import { Search, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useAddFinding, useDismissFinding, useMarkFindingFixed } from '@/api/security';
import { useBoardContext } from '@/components/board/BoardContext';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { FindingCard, type FindingActions } from './FindingCard';
import { SEVERITY_STYLE, SOURCE_LABELS, STATUS_LABELS } from './model';

/** Add to board, dismiss, mark fixed, restore: with the toasts (and undo) every list uses. */
export function useFindingActions(): FindingActions {
  const { tasks, openTask } = useBoardContext();
  const add = useAddFinding();
  const dismiss = useDismissFinding();
  const fixed = useMarkFindingFixed();
  return {
    adding: add.isPending ? (add.variables?.id ?? null) : null,
    onAdd: (f) =>
      add.mutate(f, {
        onSuccess: ({ task }) =>
          toast.success(`Added to Backlog as #${task.number}`, { description: task.title, action: { label: 'Open', onClick: () => openTask(task) } }),
      }),
    onOpenTask: (f) => {
      const task = tasks.find((t) => t.id === f.taskId);
      if (task) openTask(task);
      else toast('That task is no longer on the board.');
    },
    onDismiss: (f, reason, note) =>
      dismiss.mutate(
        { finding: f, reason, note, undo: false },
        {
          onSuccess: () =>
            toast(`${findingRef(f.number)} dismissed: ${SECURITY_DISMISS_LABELS[reason].toLowerCase()}`, {
              description: f.title,
              action: { label: 'Undo', onClick: () => dismiss.mutate({ finding: f, undo: true }) },
            }),
        },
      ),
    onRestore: (f) => dismiss.mutate({ finding: f, undo: true }),
    onFixed: (f, undo) =>
      fixed.mutate(
        { finding: f, undo },
        {
          onSuccess: () =>
            undo
              ? toast(`${findingRef(f.number)} is open again`)
              : toast(`${findingRef(f.number)} marked as fixed`, {
                  description: 'The next audit or scan checks it.',
                  action: { label: 'Undo', onClick: () => fixed.mutate({ finding: f, undo: true }) },
                }),
        },
      ),
  };
}

const STATUSES: SecurityFindingStatus[] = ['open', 'added', 'fixed', 'dismissed'];
type SourceFilter = SecuritySource | 'all';

const EMPTY: Record<SecurityFindingStatus, string> = {
  open: 'Nothing open here.',
  added: 'No findings are on the board.',
  fixed: 'Nothing fixed yet.',
  dismissed: 'Nothing dismissed.',
};

export function FindingsList({
  findings,
  source,
  focus,
  emptyHint,
}: {
  findings: SecurityFindingView[];
  /** Only this source's findings, without the source filter. */
  source?: SecuritySource;
  /** A finding number to open and scroll to (from ?finding=). */
  focus?: number | null;
  /** Under the empty state, when there are no findings at all. */
  emptyHint?: string;
}) {
  const { tasks } = useBoardContext();
  const actions = useFindingActions();
  const mine = useMemo(() => (source ? findings.filter((f) => f.source === source) : findings), [findings, source]);
  const focused = focus ? mine.find((f) => f.number === focus) : undefined;
  const [status, setStatus] = useState<SecurityFindingStatus>(focused?.status ?? 'open');
  const [severities, setSeverities] = useState<Set<SecuritySeverity>>(new Set());
  const [from, setFrom] = useState<SourceFilter>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set(focused ? [focused.id] : []));

  useEffect(() => {
    if (!focused) return;
    setStatus(focused.status);
    setOpen((prev) => new Set(prev).add(focused.id));
    requestAnimationFrame(() => document.getElementById(`finding-${focused.number}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    // Only when the focus changes, not on every list update.
  }, [focused?.id]);

  const counts = useMemo(() => {
    const c = { open: 0, added: 0, fixed: 0, dismissed: 0 } as Record<SecurityFindingStatus, number>;
    for (const f of mine) c[f.status]++;
    return c;
  }, [mine]);
  const needle = query.trim().toLowerCase();
  const shown = mine.filter(
    (f) =>
      f.status === status &&
      (severities.size === 0 || severities.has(f.severity)) &&
      (source || from === 'all' || f.source === from) &&
      (!needle ||
        f.title.toLowerCase().includes(needle) ||
        (f.file?.toLowerCase().includes(needle) ?? false) ||
        findingRef(f.number).toLowerCase() === needle.replace(/^s(\d)/, 's-$1')),
  );
  const toggleSeverity = (s: SecuritySeverity) =>
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (mine.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
        <ShieldCheck className="size-5 text-muted-foreground" />
        <p className="text-[13px] font-medium">No findings yet</p>
        {emptyHint && <p className="max-w-md text-[12.5px] text-muted-foreground">{emptyHint}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Finding status" className="flex items-center rounded-md border border-border p-0.5">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={status === s}
              onClick={() => setStatus(s)}
              className={cn(
                'flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                status === s ? 'bg-secondary text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {STATUS_LABELS[s]}
              <span className="font-mono text-[10.5px] tabular opacity-70">{counts[s]}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Severity">
          {SECURITY_SEVERITIES.map((s) => {
            const on = severities.has(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => toggleSeverity(s)}
                className={cn(
                  'flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11.5px] transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                  on ? 'border-border-strong bg-secondary text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <span className={cn('size-1.5 rounded-full', SEVERITY_STYLE[s].dot)} />
                {SEVERITY_STYLE[s].label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
          {!source && (
            <Select<SourceFilter>
              size="sm"
              value={from}
              onValueChange={setFrom}
              aria-label="Source"
              className="w-40"
              options={[{ value: 'all', label: 'All sources' }, ...SECURITY_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s] }))]}
            />
          )}
          <div className="relative min-w-0 flex-1 sm:w-48 sm:flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search findings" className="h-7 pl-7 text-xs" />
          </div>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-muted-foreground">
          {severities.size || needle || from !== 'all' ? 'No findings match these filters.' : EMPTY[status]}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              task={f.taskId ? tasks.find((t) => t.id === f.taskId) : undefined}
              expanded={open.has(f.id)}
              onToggle={() => toggle(f.id)}
              actions={actions}
              hideSource={Boolean(source)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
