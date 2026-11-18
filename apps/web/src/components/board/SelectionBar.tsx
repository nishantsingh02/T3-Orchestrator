// Floating bar for the checked Backlog and Ready cards: move them between the two lanes, or discard them.
import type { TaskAction, TaskView } from '@t3-orchestra/shared';
import { ArrowLeft, ArrowRight, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Tip } from '@/components/ui/tooltip';
import { useHotkeys } from '@/lib/hotkeys';
import { positionsBetween } from '@/lib/position';
import { laneFor, type BoardLane } from '@/lib/stage';
import { useBoardContext } from './BoardContext';
import type { CheckedCards } from './useCheckedCards';

/** Positions after the last card in `lane` (filtered-out cards included), so the moved cards queue up behind it in order. */
export function appendPositions(tasks: TaskView[], lane: BoardLane, moving: TaskView[]): Map<string, number> {
  let last: number | undefined;
  for (const t of tasks) if (laneFor(t) === lane && (last === undefined || t.position > last)) last = t.position;
  const positions = positionsBetween(last, undefined, moving.length);
  return new Map(moving.map((t, i) => [t.id, positions[i] as number]));
}

export function SelectionBar({ checks }: { checks: CheckedCards }) {
  const { tasks, runMany } = useBoardContext();
  const confirm = useConfirm();
  const list = checks.tasks;
  const inBacklog = list.filter((t) => laneFor(t) === 'backlog');
  const inReady = list.filter((t) => laneFor(t) === 'ready');
  const mixed = inBacklog.length > 0 && inReady.length > 0;

  useHotkeys({ Escape: checks.clear }, { enabled: list.length > 0 });

  const move = (moving: TaskView[], action: TaskAction, to: BoardLane) => {
    checks.clear();
    void runMany(moving, action, { positions: appendPositions(tasks, to, moving) });
  };

  const discard = async () => {
    const ok = await confirm(
      list.length === 1
        ? {
            title: `Discard #${list[0]?.number}?`,
            description:
              'The task is hidden from the board. Its branch and worktree are left alone; clean them up in T3 if you no longer need them.',
            confirmLabel: 'Discard',
            variant: 'destructive',
          }
        : {
            title: `Discard ${list.length} tasks?`,
            description: `${list.map((t) => `#${t.number}`).join(', ')} will be hidden from the board. Any branches and worktrees are left alone.`,
            confirmLabel: `Discard ${list.length}`,
            variant: 'destructive',
          },
    );
    if (!ok) return;
    checks.clear();
    void runMany(list, 'discard');
  };

  if (list.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
      <div
        role="toolbar"
        aria-label="Selected tasks"
        className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-border-strong bg-popover p-1 pl-3 text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2"
      >
        <span className="text-xs font-medium whitespace-nowrap tabular">{list.length} selected</span>
        <span className="mx-1.5 h-4 w-px shrink-0 bg-border" />
        {inBacklog.length > 0 && (
          <Button size="sm" onClick={() => move(inBacklog, 'move-to-ready', 'ready')}>
            <ArrowRight />
            {mixed ? `Move ${inBacklog.length} to Ready` : 'Move to Ready'}
          </Button>
        )}
        {inReady.length > 0 && (
          <Button size="sm" variant={mixed ? 'ghost' : 'default'} onClick={() => move(inReady, 'move-to-backlog', 'backlog')}>
            <ArrowLeft />
            {mixed ? `Move ${inReady.length} to Backlog` : 'Move to Backlog'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => void discard()}
        >
          <Trash2 />
          Discard
        </Button>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />
        <Tip content="Clear selection (Esc)">
          <Button size="icon-sm" variant="ghost" onClick={checks.clear} aria-label="Clear selection">
            <X />
          </Button>
        </Tip>
      </div>
    </div>
  );
}
