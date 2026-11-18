// Checkbox selection of Backlog and Ready cards, for moving or discarding several at once.
import type { TaskView } from '@t3-orchestra/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { laneFor, type BoardLane } from '@/lib/stage';

/** Lanes whose cards have a checkbox. */
export const CHECKABLE_LANES: ReadonlySet<BoardLane> = new Set(['backlog', 'ready']);

export interface CheckedCards {
  /** Checked cards still shown in a checkable lane, in board order. */
  tasks: TaskView[];
  ids: ReadonlySet<string>;
  /** Toggles a card; with `range`, sets every card between the last one toggled and this one. */
  toggle: (task: TaskView, range: boolean) => void;
  /** Checks or unchecks every shown card in a lane. */
  setLane: (lane: BoardLane, on: boolean) => void;
  clear: () => void;
}

export function useCheckedCards(lanes: BoardLane[], byLane: Record<BoardLane, TaskView[]>): CheckedCards {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);

  const tasks = useMemo(
    () => lanes.filter((l) => CHECKABLE_LANES.has(l)).flatMap((l) => byLane[l].filter((t) => ids.has(t.id))),
    [lanes, byLane, ids],
  );

  // Cards that left Backlog/Ready (the scheduler started one) or are hidden by the filter drop out.
  useEffect(() => {
    if (tasks.length !== ids.size) setIds(new Set(tasks.map((t) => t.id)));
  }, [tasks, ids]);

  const toggle = useCallback(
    (task: TaskView, range: boolean) => {
      const list = byLane[laneFor(task)];
      const from = range && anchor.current ? list.findIndex((t) => t.id === anchor.current) : -1;
      const to = list.findIndex((t) => t.id === task.id);
      anchor.current = task.id;
      setIds((prev) => {
        const next = new Set(prev);
        const on = !prev.has(task.id);
        const span = from !== -1 && to !== -1 ? list.slice(Math.min(from, to), Math.max(from, to) + 1) : [task];
        for (const t of span) {
          if (on) next.add(t.id);
          else next.delete(t.id);
        }
        return next;
      });
    },
    [byLane],
  );

  const setLane = useCallback(
    (lane: BoardLane, on: boolean) => {
      setIds((prev) => {
        const next = new Set(prev);
        for (const t of byLane[lane]) {
          if (on) next.add(t.id);
          else next.delete(t.id);
        }
        return next;
      });
    },
    [byLane],
  );

  const clear = useCallback(() => {
    anchor.current = null;
    setIds(new Set());
  }, []);

  return { tasks, ids, toggle, setLane, clear };
}
