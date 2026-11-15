import { useQueryClient } from '@tanstack/react-query';
import { boardOverview, COLUMN_ORDER, type MilestoneView, type TaskView } from '@t3-orchestra/shared';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, EllipsisVertical, FolderInput, Pencil, Plus, Sparkles, Trash } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { keys } from '@/api/keys';
import { useDeleteMilestone, usePatchMilestone, useSuggestions } from '@/api/milestones';
import { usePatchTask } from '@/api/tasks';
import { milestoneKey, useBoardContext } from '@/components/board/BoardContext';
import { Card, Empty, plural, TaskRow } from '@/components/overview/parts';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { LANE_LABELS, laneFor } from '@/lib/stage';
import { cn } from '@/lib/utils';
import { MilestoneDialog } from './MilestoneDialog';
import { nextMilestonePrompt } from './nextMilestonePrompt';
import { SuggestionsInbox } from './SuggestionsInbox';

type Status = 'done' | 'active' | 'todo' | 'empty';

const STATUS: Record<Status, { label: string; className: string }> = {
  done: { label: 'Done', className: 'border-success/35 bg-success/12 text-success' },
  active: { label: 'In progress', className: 'border-primary/35 bg-primary/10 text-primary' },
  todo: { label: 'Not started', className: 'border-border text-muted-foreground' },
  empty: { label: 'No tasks', className: 'border-border text-muted-foreground' },
};

function statusOf(list: TaskView[]): Status {
  if (list.length === 0) return 'empty';
  if (list.every((t) => t.stage === 'done')) return 'done';
  if (list.some((t) => t.stage !== 'backlog' && t.stage !== 'ready')) return 'active';
  return 'todo';
}

const laneRank = (t: TaskView) => COLUMN_ORDER.indexOf(laneFor(t) as (typeof COLUMN_ORDER)[number]);

/** Open tasks in board-column order (Running before Ready…), then by position. */
function byWork(a: TaskView, b: TaskView): number {
  return laneRank(b) - laneRank(a) || a.position - b.position || a.number - b.number;
}

function MoveMenu({ task }: { task: TaskView }) {
  const { milestones, run } = useBoardContext();
  const patch = usePatchTask();
  const move = (milestoneId: string | null) => patch.mutate({ task, patch: { milestoneId } });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" aria-label={`Move #${task.number}`}>
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {task.stage === 'backlog' && (
          <>
            <DropdownMenuItem onSelect={() => void run(task, 'move-to-ready')}>Move to Ready</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Move to milestone</DropdownMenuLabel>
        {milestones.map((m) => (
          <DropdownMenuItem key={m.id} disabled={task.milestoneId === m.id} onSelect={() => move(m.id)}>
            <FolderInput />
            <span className="w-7 shrink-0 font-mono text-[11px] text-muted-foreground">{milestoneKey(m)}</span>
            <span className="min-w-0 truncate">{m.title}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem disabled={task.milestoneId === null} onSelect={() => move(null)}>
          <FolderInput />
          No milestone
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskList({ tasks, emptyText }: { tasks: TaskView[]; emptyText: string }) {
  const open = tasks.filter((t) => t.stage !== 'done').sort(byWork);
  const done = tasks.filter((t) => t.stage === 'done').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const [showDone, setShowDone] = useState(false);
  const row = (t: TaskView) => (
    <TaskRow key={t.id} task={t} meta={LANE_LABELS[laneFor(t)]} actions={<MoveMenu task={t} />} />
  );
  if (tasks.length === 0) return <Empty>{emptyText}</Empty>;
  return (
    <div className="flex flex-col gap-1">
      {open.length > 0 && <ul className="-mx-2 flex flex-col">{open.map(row)}</ul>}
      {done.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            className="flex items-center gap-1 self-start py-1 text-[11.5px] text-muted-foreground hover:text-foreground"
            aria-expanded={showDone}
          >
            {showDone ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {plural(done.length, 'done task')}
          </button>
          {showDone && <ul className="-mx-2 flex flex-col">{done.map(row)}</ul>}
        </>
      )}
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-stage-done/15">
        <div className="h-full rounded-full bg-stage-done" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      <span className="w-14 text-right tabular">
        {done}
        <span className="text-muted-foreground">/{total}</span>
      </span>
    </div>
  );
}

function MilestoneCard({
  milestone,
  tasks,
  index,
  count,
  eta,
  onEdit,
  onMove,
}: {
  milestone: MilestoneView;
  tasks: TaskView[];
  index: number;
  count: number;
  eta: string | null;
  onEdit: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const del = useDeleteMilestone();
  const confirm = useConfirm();
  const status = statusOf(tasks);
  const done = tasks.filter((t) => t.stage === 'done').length;
  const [open, setOpen] = useState(status !== 'done');

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${milestoneKey(milestone)} ${milestone.title}?`,
      description: tasks.length
        ? `Its ${plural(tasks.length, 'task')} stay on the board, without a milestone.`
        : 'It has no tasks.',
      confirmLabel: 'Delete milestone',
      variant: 'destructive',
    });
    if (ok) del.mutate(milestone);
  };

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 rounded text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-[11.5px] text-muted-foreground">{milestoneKey(milestone)}</span>
            <h2 className="text-[14px] font-semibold tracking-tight">{milestone.title}</h2>
            <span className={cn('rounded-[4px] border px-1.5 py-px text-[10.5px] leading-4 font-medium', STATUS[status].className)}>
              {STATUS[status].label}
            </span>
          </div>
          {milestone.goal && <p className="mt-1 text-[12.5px] text-muted-foreground">{milestone.goal}</p>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={`${milestoneKey(milestone)} actions`}>
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(-1)}>
              <ArrowUp />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={index === count - 1} onSelect={() => onMove(1)}>
              <ArrowDown />
              Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
              <Trash />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {tasks.length > 0 && (
        <div className="flex flex-col gap-1">
          <Progress done={done} total={tasks.length} />
          {eta && status !== 'done' && <p className="text-xs text-muted-foreground">{eta}</p>}
        </div>
      )}
      {open && (
        <TaskList tasks={tasks} emptyText="No tasks yet. Add suggestions from the inbox, or move tasks here with a task's ⋮ menu." />
      )}
    </section>
  );
}

export function RoadmapView({ loading }: { loading: boolean }) {
  const { board, tasks, milestones, pauseAll, openPlanComposer } = useBoardContext();
  const patchMilestone = usePatchMilestone();
  const suggestions = useSuggestions(board.id);
  const [editing, setEditing] = useState<MilestoneView | 'new' | null>(null);

  // Suggestions come from task results: refetch when a task's result or follow-ups change.
  const qc = useQueryClient();
  const signature = useMemo(
    () => tasks.map((t) => `${t.id}:${t.stage}:${t.lastSummary?.length ?? 0}:${t.followUpOf ?? ''}`).join('|'),
    [tasks],
  );
  const seen = useRef(signature);
  useEffect(() => {
    if (seen.current === signature) return;
    seen.current = signature;
    void qc.invalidateQueries({ queryKey: keys.suggestions(board.id), exact: true });
  }, [signature, qc, board.id]);

  const live = useMemo(() => tasks.filter((t) => t.stage !== 'discarded'), [tasks]);
  const byMilestone = useMemo(() => {
    const map = new Map<string | null, TaskView[]>();
    const ids = new Set(milestones.map((m) => m.id));
    for (const t of live) {
      const key = t.milestoneId && ids.has(t.milestoneId) ? t.milestoneId : null;
      map.set(key, [...(map.get(key) ?? []), t]);
    }
    return map;
  }, [live, milestones]);

  // Rough finish estimates: milestones finish in order at the board's recent pace.
  const pace = useMemo(() => boardOverview(tasks, { board, pauseAll }).pace, [tasks, board, pauseAll]);
  const etas = useMemo(() => {
    const out = new Map<string, string | null>();
    let remaining = 0;
    for (const m of milestones) {
      remaining += (byMilestone.get(m.id) ?? []).filter((t) => t.stage !== 'done').length;
      if (pace.perDay <= 0 || remaining === 0) out.set(m.id, null);
      else {
        const days = remaining / pace.perDay;
        out.set(m.id, days < 1 ? 'Under a day away at the board’s recent pace' : `About ${plural(Math.round(days), 'day')} away at the board’s recent pace`);
      }
    }
    return out;
  }, [milestones, byMilestone, pace.perDay]);

  const move = (i: number, dir: -1 | 1) => {
    const a = milestones[i]!;
    const b = milestones[i + dir];
    if (!b) return;
    // Swap positions (equal positions get spread apart).
    const pa = a.position === b.position ? b.position + dir : b.position;
    patchMilestone.mutate({ milestone: a, patch: { position: pa } });
    patchMilestone.mutate({ milestone: b, patch: { position: a.position } });
  };

  const unassigned = byMilestone.get(null) ?? [];

  if (loading) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-3 p-3 sm:p-4">
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  const header: ReactNode = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[15px] font-semibold tracking-tight">Roadmap</h1>
        <p className="text-xs text-muted-foreground">Milestones in the order auto-run works through them.</p>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
          <Plus />
          New milestone
        </Button>
        <Tip content="Opens the plan composer with what's done, what's open and the agents' suggestions">
          <Button
            size="sm"
            onClick={() => openPlanComposer(nextMilestonePrompt({ milestones, tasks: live, suggestions: suggestions.data ?? [] }))}
          >
            <Sparkles />
            Plan next milestone
          </Button>
        </Tip>
      </div>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 p-3 sm:p-4">
        {header}
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
          <div className="flex min-w-0 flex-col gap-3">
            {milestones.length === 0 && (
              <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-5">
                <p className="text-[13px] font-medium">No milestones yet</p>
                <p className="text-[12.5px] text-muted-foreground">
                  Milestones split the work into phases that each end in something that works. New plans group their tasks into
                  milestones, or add one by hand and move tasks into it.
                </p>
              </div>
            )}
            {milestones.map((m, i) => (
              <MilestoneCard
                key={m.id}
                milestone={m}
                tasks={byMilestone.get(m.id) ?? []}
                index={i}
                count={milestones.length}
                eta={etas.get(m.id) ?? null}
                onEdit={() => setEditing(m)}
                onMove={(dir) => move(i, dir)}
              />
            ))}
            <Card
              title="No milestone"
              subtitle={
                milestones.length
                  ? 'Auto-run starts these after the milestones’ tasks.'
                  : 'Every task on the board, until you add milestones.'
              }
            >
              <TaskList tasks={unassigned} emptyText="Every task is in a milestone." />
            </Card>
          </div>
          <SuggestionsInbox suggestions={suggestions.data} loading={suggestions.isLoading} />
        </div>
      </div>
      <MilestoneDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        milestone={editing === 'new' ? null : editing}
      />
    </div>
  );
}
