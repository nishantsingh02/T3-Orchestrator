import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { COLUMN_EMPTY_TEXT, type TaskView } from '@t3-orchestra/shared';
import { ChevronsLeftRight, ChevronsRightLeft, Plus } from 'lucide-react';
import { SortableTaskCard } from '@/components/tasks/TaskCard';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Tip } from '@/components/ui/tooltip';
import { LANE_LABELS, LANE_STYLE, type BoardLane } from '@/lib/stage';
import { cn } from '@/lib/utils';
import type { CheckedCards } from './useCheckedCards';

export type DropState = { kind: 'idle' } | { kind: 'source' } | { kind: 'allowed'; hint: string; over: boolean } | { kind: 'refused'; over: boolean };

interface Props {
  lane: BoardLane;
  tasks: TaskView[];
  selectedId: string | null;
  drop: DropState;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onAddTask?: () => void;
  /** Card checkboxes (Backlog and Ready). */
  checks?: CheckedCards;
}

const EMPTY_TEXT: Record<BoardLane, string> = { ...COLUMN_EMPTY_TEXT, discarded: 'Nothing discarded' };

export function Column({ lane, tasks, selectedId, drop, collapsed, onToggleCollapse, onAddTask, checks }: Props) {
  const { setNodeRef } = useDroppable({ id: `lane:${lane}`, data: { type: 'lane', lane } });
  const style = LANE_STYLE[lane];
  const checkedHere = checks ? tasks.filter((t) => checks.ids.has(t.id)).length : 0;
  const allChecked = tasks.length > 0 && checkedHere === tasks.length;

  if (collapsed) {
    return (
      <section
        ref={setNodeRef}
        className={cn(
          'flex w-10 shrink-0 flex-col items-center gap-2 rounded-lg border border-t-2 border-border bg-surface py-2 transition-colors',
          style.border,
          drop.kind === 'allowed' && 'border-dashed bg-accent/40',
          drop.kind === 'allowed' && drop.over && 'bg-accent',
        )}
      >
        <Tip content={`Expand ${LANE_LABELS[lane]}`} side="right">
          <Button variant="ghost" size="icon-xs" onClick={onToggleCollapse} aria-label={`Expand ${LANE_LABELS[lane]}`}>
            <ChevronsLeftRight />
          </Button>
        </Tip>
        <span className="font-mono text-[11px] text-muted-foreground tabular">{tasks.length}</span>
        <span className="text-xs font-medium text-muted-foreground [writing-mode:vertical-rl]">{LANE_LABELS[lane]}</span>
      </section>
    );
  }

  return (
    <section
      ref={setNodeRef}
      className={cn(
        'flex max-h-full min-h-0 w-[272px] shrink-0 flex-col rounded-lg border border-t-2 border-border bg-surface transition-[opacity,background-color,border-color] lg:w-auto lg:min-w-[248px] lg:flex-1 lg:basis-0 2xl:max-w-[380px]',
        style.border,
        drop.kind === 'refused' && 'opacity-45',
        drop.kind === 'allowed' && 'border-x-border-strong border-b-border-strong',
        drop.kind === 'allowed' && drop.over && 'bg-accent/60',
      )}
      aria-label={LANE_LABELS[lane]}
    >
      <header className="flex h-9 shrink-0 items-center gap-1.5 px-2.5">
        {checks && tasks.length > 0 ? (
          // Lined up with the card checkboxes below (lane padding + card border + card padding).
          <Checkbox
            checked={allChecked ? true : checkedHere > 0 ? 'indeterminate' : false}
            onCheckedChange={() => checks.setLane(lane, !allChecked)}
            aria-label={allChecked ? `Clear ${LANE_LABELS[lane]} selection` : `Select all in ${LANE_LABELS[lane]}`}
            title={allChecked ? 'Clear selection' : `Select all in ${LANE_LABELS[lane]}`}
            className="ml-[7px] relative after:absolute after:-inset-1.5"
          />
        ) : (
          <span className={cn('size-1.5 rounded-full', style.dot)} />
        )}
        <h2 className="text-[12.5px] font-semibold tracking-tight">{LANE_LABELS[lane]}</h2>
        <span className="font-mono text-[11px] text-muted-foreground tabular">{tasks.length}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {drop.kind === 'allowed' && (
            <span className={cn('rounded px-1.5 py-0.5 text-[10.5px] font-medium', style.bg, style.text)}>{drop.hint}</span>
          )}
          {drop.kind === 'refused' && drop.over && (
            <span className="rounded bg-destructive/12 px-1.5 py-0.5 text-[10.5px] font-medium text-destructive">
              Not allowed
            </span>
          )}
          {drop.kind === 'idle' && onAddTask && (
            <Tip content="New task (N)">
              <Button variant="ghost" size="icon-xs" onClick={onAddTask} aria-label="New task">
                <Plus />
              </Button>
            </Tip>
          )}
          {drop.kind === 'idle' && onToggleCollapse && (
            <Tip content={`Collapse ${LANE_LABELS[lane]}`}>
              <Button variant="ghost" size="icon-xs" onClick={onToggleCollapse} aria-label={`Collapse ${LANE_LABELS[lane]}`}>
                <ChevronsRightLeft />
              </Button>
            </Tip>
          )}
        </div>
      </header>
      <div
        className={cn(
          'flex min-h-24 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5 scrollbar-thin',
          drop.kind === 'allowed' && drop.over && 'rounded-b-lg',
        )}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((t) => (
            <SortableTaskCard
              key={t.id}
              task={t}
              selected={t.id === selectedId}
              checked={checks?.ids.has(t.id)}
              onCheck={checks?.toggle}
            />
          ))}
        </SortableContext>
        {tasks.length === 0 && (
          <div
            className={cn(
              'flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground/80',
              drop.kind === 'allowed' && 'border-border-strong',
            )}
          >
            {drop.kind === 'allowed' ? drop.hint : EMPTY_TEXT[lane]}
          </div>
        )}
      </div>
    </section>
  );
}
