import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Over,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { TaskView } from '@t3-orchestra/shared';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { usePatchTask } from '@/api/tasks';
import { TaskCard } from '@/components/tasks/TaskCard';
import { positionAt, positionsBetween } from '@/lib/position';
import { LANE_LABELS, laneFor, type BoardLane } from '@/lib/stage';
import { cn } from '@/lib/utils';
import { useBoardContext } from './BoardContext';
import { Column, type DropState } from './Column';
import { dropRule, refusalReason, REORDERABLE } from './dropRules';
import { SelectionBar } from './SelectionBar';
import { CHECKABLE_LANES, useCheckedCards } from './useCheckedCards';

// Prefer the card under the pointer, then the lane under the pointer, then the nearest corner
// (keyboard dragging has no pointer).
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (hits.length > 0) {
    const cards = hits.filter((c) => !String(c.id).startsWith('lane:'));
    return cards.length > 0 ? cards : hits;
  }
  return closestCorners(args);
};

function laneOfOver(over: Over | null): BoardLane | null {
  const lane = (over?.data.current as { lane?: BoardLane } | undefined)?.lane;
  return lane ?? null;
}

interface Props {
  lanes: BoardLane[];
  byLane: Record<BoardLane, TaskView[]>;
  selectedId: string | null;
  collapsed: ReadonlySet<BoardLane>;
  onToggleCollapse: (lane: BoardLane) => void;
  onAddTask: () => void;
}

export function BoardColumns({ lanes, byLane, selectedId, collapsed, onToggleCollapse, onAddTask }: Props) {
  const { tasks, run, runMany, board } = useBoardContext();
  const patchTask = usePatchTask();
  const checks = useCheckedCards(lanes, byLane);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overLane, setOverLane] = useState<BoardLane | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  );

  const activeTask = useMemo(() => tasks.find((t) => t.id === activeId) ?? null, [tasks, activeId]);
  const sourceLane = activeTask ? laneFor(activeTask) : null;

  // Dragging a checked card takes the other checked cards in its lane along.
  const dragGroup = useMemo(() => {
    if (!activeTask || !sourceLane) return [];
    if (!checks.ids.has(activeTask.id)) return [activeTask];
    return byLane[sourceLane].filter((t) => checks.ids.has(t.id));
  }, [activeTask, sourceLane, checks.ids, byLane]);
  const groupSize = dragGroup.length;

  const dropStateFor = (lane: BoardLane): DropState => {
    if (!sourceLane) return { kind: 'idle' };
    if (lane === sourceLane) return { kind: 'source' };
    const rule = dropRule(sourceLane, lane);
    // A group only moves between lanes; tasks are started one at a time.
    if (rule && (groupSize < 2 || rule.keepsPosition)) {
      return { kind: 'allowed', hint: groupSize > 1 ? `${rule.hint} (${groupSize})` : rule.hint, over: overLane === lane };
    }
    return { kind: 'refused', over: overLane === lane };
  };

  const reset = () => {
    setActiveId(null);
    setOverLane(null);
  };

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragOver = (e: DragOverEvent) => setOverLane(laneOfOver(e.over));

  const onDragEnd = (e: DragEndEvent) => {
    const task = activeTask;
    const from = sourceLane;
    const group = dragGroup;
    const to = laneOfOver(e.over);
    reset();
    if (!task || !from || !to || !e.over) return;
    const overId = String(e.over.id);
    const overIsCard = overId !== `lane:${to}`;

    if (from === to) {
      if (!REORDERABLE.has(from) || !overIsCard) return;
      const list = byLane[from];
      if (group.length > 1) {
        const moving = new Set(group.map((t) => t.id));
        const rest = list.filter((t) => !moving.has(t.id));
        const overIndex = rest.findIndex((t) => t.id === overId);
        if (overIndex === -1) return;
        // Dragged down: the group lands after the card under the pointer; dragged up: before it.
        const down = list.findIndex((t) => t.id === task.id) < list.findIndex((t) => t.id === overId);
        const at = down ? overIndex + 1 : overIndex;
        const positions = positionsBetween(rest[at - 1]?.position, rest[at]?.position, group.length);
        group.forEach((t, i) => patchTask.mutate({ task: t, patch: { position: positions[i] as number } }));
        return;
      }
      const oldIndex = list.findIndex((t) => t.id === task.id);
      const newIndex = list.findIndex((t) => t.id === e.over?.id);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      const moved = arrayMove(list, oldIndex, newIndex);
      const rest = moved.filter((t) => t.id !== task.id);
      patchTask.mutate({ task, patch: { position: positionAt(rest, newIndex) } });
      return;
    }

    const rule = dropRule(from, to);
    if (!rule) {
      toast(`Can't move #${task.number} from ${LANE_LABELS[from]} to ${LANE_LABELS[to]}`, {
        description: refusalReason(from, to),
      });
      return;
    }
    if (group.length > 1) {
      if (!rule.keepsPosition) {
        toast(`Can't start ${group.length} tasks at once`, {
          description: 'Start them one at a time, or move them to Ready and let auto-run pick them up.',
        });
        return;
      }
      const target = byLane[to];
      const index = overIsCard ? target.findIndex((t) => t.id === overId) : -1;
      const at = index === -1 ? target.length : index;
      const positions = positionsBetween(target[at - 1]?.position, target[at]?.position, group.length);
      checks.clear();
      void runMany(group, rule.action, { positions: new Map(group.map((t, i) => [t.id, positions[i] as number])) });
      return;
    }

    let position: number | undefined;
    if (rule.keepsPosition) {
      const target = byLane[to];
      const index = overIsCard ? target.findIndex((t) => t.id === e.over?.id) : target.length;
      position = positionAt(target, index === -1 ? target.length : index);
    }
    void run(task, rule.action, {}, { confirm: rule.confirm, board, position });
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
      accessibility={{
        screenReaderInstructions: {
          draggable: 'Press Space to pick up a task, arrow keys to move it, Space to drop, Escape to cancel. Enter opens it.',
        },
      }}
    >
      <div className="relative h-full min-h-0">
        <div
          className={cn(
            'flex h-full min-h-0 gap-2 overflow-x-auto px-3 pb-3 transition-[padding] duration-150 scrollbar-thin',
            checks.tasks.length > 0 && 'pb-16', // room for the selection bar
          )}
        >
          {lanes.map((lane) => (
            <Column
              key={lane}
              lane={lane}
              tasks={byLane[lane]}
              selectedId={selectedId}
              drop={dropStateFor(lane)}
              collapsed={collapsed.has(lane)}
              onToggleCollapse={lane === 'done' ? () => onToggleCollapse(lane) : undefined}
              onAddTask={lane === 'backlog' ? onAddTask : undefined}
              checks={CHECKABLE_LANES.has(lane) ? checks : undefined}
            />
          ))}
        </div>
        <SelectionBar checks={checks} />
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
        {activeTask ? (
          <div className="relative w-[260px]">
            {groupSize > 1 && (
              <div className="absolute inset-0 translate-x-1.5 translate-y-1.5 rounded-md border border-border bg-card shadow-lg" />
            )}
            <TaskCard
              task={activeTask}
              overlay
              checked={checks.ids.has(activeTask.id)}
              onCheck={sourceLane && CHECKABLE_LANES.has(sourceLane) ? checks.toggle : undefined}
            />
            {groupSize > 1 && (
              <span className="absolute -top-2 -right-2 z-10 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground shadow-md tabular">
                {groupSize}
              </span>
            )}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
