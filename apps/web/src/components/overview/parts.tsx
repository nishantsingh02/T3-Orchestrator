// Building blocks shared by the Overview and the Roadmap.
import type { TaskView } from '@t3-orchestra/shared';
import { useState, type ReactNode } from 'react';
import { useBoardContext } from '@/components/board/BoardContext';
import { Tip } from '@/components/ui/tooltip';
import { LANE_STYLE, laneFor } from '@/lib/stage';
import { cn } from '@/lib/utils';

export function Card({
  title,
  subtitle,
  actions,
  className,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4', className)}>
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function StatTile({ label, value, unit, note }: { label: string; value: ReactNode; unit?: string; note?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-[22px] leading-7 font-semibold tracking-tight">{value}</span>
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </span>
      {note && <span className="truncate text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

/** Done-of-total meter: the track is a lighter step of the fill's hue. */
export function Meter({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total ? (done / total) * 100 : 0;
  return (
    <div className="grid grid-cols-[84px_1fr_auto] items-center gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Tip content={`${label}: ${done} of ${total} done`}>
        <div className="h-2 overflow-hidden rounded-full bg-stage-done/15">
          <div className="h-full rounded-full bg-stage-done" style={{ width: `${pct}%` }} />
        </div>
      </Tip>
      <span className="w-14 text-right tabular">
        {done}
        <span className="text-muted-foreground">/{total}</span>
      </span>
    </div>
  );
}

/** A clickable task line (opens the drawer); `actions` sit after it, outside the button. */
export function TaskRow({ task, meta, actions }: { task: TaskView; meta?: ReactNode; actions?: ReactNode }) {
  const { openTask } = useBoardContext();
  return (
    <li className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={() => openTask(task)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      >
        <span className={cn('size-1.5 shrink-0 rounded-full', LANE_STYLE[laneFor(task)].dot)} />
        <span className="w-8 shrink-0 font-mono text-[11px] text-muted-foreground tabular">#{task.number}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px]">{task.title}</span>
        {meta && <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-muted-foreground">{meta}</span>}
      </button>
      {actions}
    </li>
  );
}

/** A list that shows its first `limit` rows and a "+N more" toggle. */
export function RowList({ items, limit = 5, render }: { items: TaskView[]; limit?: number; render: (t: TaskView) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, limit);
  return (
    <ul className="-mx-2 flex flex-col">
      {shown.map(render)}
      {items.length > limit && (
        <li>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="px-2 py-1 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            {open ? 'Show less' : `+${items.length - limit} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-[12.5px] text-muted-foreground">{children}</p>;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
