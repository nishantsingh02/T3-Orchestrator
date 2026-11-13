import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TaskView } from '@t3-orchestra/shared';
import { ExternalLink, GitPullRequest, ListStart, Palette, Play, RotateCcw, SquareArrowOutUpRight } from 'lucide-react';
import { memo, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { usePatchTask } from '@/api/tasks';
import { useBoardContext } from '@/components/board/BoardContext';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { laneFor, type BoardLane } from '@/lib/stage';
import { cn } from '@/lib/utils';
import { PipelineStrip } from './PipelineStrip';
import { StatusLine } from './StatusLine';
import { TaskChips } from './TaskChips';
import { useActionPending } from './useTaskActions';

/** Lanes whose cards can be picked up (v1 can't stop running threads). */
export const DRAGGABLE_LANES: ReadonlySet<BoardLane> = new Set(['backlog', 'ready', 'human_review', 'failed']);

const stop = (e: MouseEvent | KeyboardEvent | PointerEvent) => e.stopPropagation();

/** The thread link for whatever is running now (the reviewer during AI review). */
export function currentThreadLink(task: TaskView): string | null {
  return task.activeRun?.threadLink ?? task.threadLink;
}

function OpenInT3({ href, primary }: { href: string; primary?: boolean }) {
  return (
    <Button asChild size="xs" variant={primary ? 'warning' : 'secondary'} onPointerDown={stop} onClick={stop}>
      <a href={href} target="_blank" rel="noreferrer">
        <ExternalLink />
        Open in T3
      </a>
    </Button>
  );
}

/** Toggles "run next": auto-run starts this Ready task before the others (one per board). */
function RunNextButton({ task }: { task: TaskView }) {
  const patchTask = usePatchTask();
  const on = task.runNext;
  return (
    <Tip
      content={
        on
          ? 'Auto-run starts this before every other Ready task, even if it overlaps running work. Click to undo.'
          : 'Start this before the other Ready tasks when a slot frees up'
      }
    >
      <Button
        size="xs"
        variant={on ? 'default' : 'ghost'}
        aria-pressed={on}
        disabled={patchTask.isPending}
        onPointerDown={stop}
        onClick={(e) => {
          stop(e);
          patchTask.mutate({ task, patch: { runNext: !on } });
        }}
      >
        <ListStart />
        {on ? 'Next up' : 'Run next'}
      </Button>
    </Tip>
  );
}

function CardActions({ task, lane }: { task: TaskView; lane: BoardLane }) {
  const { board, run, openTask, openDesigns } = useBoardContext();
  const starting = useActionPending(task.id, 'start');
  const resuming = useActionPending(task.id, 'resume');
  const link = currentThreadLink(task);
  const buttons: ReactNode[] = [];

  switch (lane) {
    case 'backlog':
    case 'ready':
      buttons.push(
        <Button
          key="start"
          size="xs"
          variant="secondary"
          disabled={starting}
          onPointerDown={stop}
          onClick={(e) => {
            stop(e);
            void run(task, 'start');
          }}
        >
          {starting ? <Spinner className="size-3" /> : <Play />}
          Start
        </Button>,
      );
      if (lane === 'ready' && (board.autoRun || task.runNext)) buttons.push(<RunNextButton key="next" task={task} />);
      break;
    case 'running':
    case 'ai_review':
    case 'needs_input':
      if (link) buttons.push(<OpenInT3 key="t3" href={link} primary={lane === 'needs_input'} />);
      break;
    case 'human_review':
      buttons.push(
        task.stageReason === 'design_options' ? (
          <Button
            key="design"
            size="xs"
            variant="default"
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              openDesigns(task);
            }}
          >
            <Palette />
            Pick design
          </Button>
        ) : (
          <Button
            key="review"
            size="xs"
            variant="default"
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              openTask(task, 'review');
            }}
          >
            Review
          </Button>
        ),
      );
      if (link) buttons.push(<OpenInT3 key="t3" href={link} />);
      break;
    case 'failed':
      buttons.push(
        <Button
          key="resume"
          size="xs"
          variant="secondary"
          disabled={resuming}
          onPointerDown={stop}
          onClick={(e) => {
            stop(e);
            void run(task, 'resume');
          }}
        >
          {resuming ? <Spinner className="size-3" /> : <RotateCcw />}
          Resume
        </Button>,
      );
      if (link) buttons.push(<OpenInT3 key="t3" href={link} />);
      break;
    case 'done':
      if (task.prUrl) {
        buttons.push(
          <Button key="pr" asChild size="xs" variant="ghost" onPointerDown={stop} onClick={stop}>
            <a href={task.prUrl} target="_blank" rel="noreferrer">
              <GitPullRequest />
              PR
            </a>
          </Button>,
        );
      }
      break;
    case 'discarded':
      break;
  }
  if (buttons.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-1.5">{buttons.slice(0, 2)}</div>;
}

interface CardProps {
  task: TaskView;
  selected?: boolean;
  /** Rendered inside the DragOverlay. */
  overlay?: boolean;
  /** The original card while its overlay is being dragged. */
  placeholder?: boolean;
  /** Its checkbox is ticked (Backlog and Ready cards, for moving several at once). */
  checked?: boolean;
  /** Shows the checkbox; `range` is a shift-click. */
  onCheck?: (task: TaskView, range: boolean) => void;
}

export const TaskCard = memo(function TaskCard({ task, selected, overlay, placeholder, checked, onCheck }: CardProps) {
  const { board, activeTasks, pauseAll, openTask } = useBoardContext();
  const lane = laneFor(task);
  const compact = lane === 'done' || lane === 'discarded';
  const busy = useActionPending(task.id);

  return (
    <div
      onClick={(e) => {
        // Shift-click and Ctrl/Cmd-click tick the card instead of opening it.
        if (onCheck && (e.shiftKey || e.ctrlKey || e.metaKey)) onCheck(task, e.shiftKey);
        else openTask(task);
      }}
      onMouseDown={(e) => {
        if (onCheck && e.shiftKey) e.preventDefault(); // no text selection on shift-click
      }}
      className={cn(
        'group relative flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5 text-left shadow-xs transition-[border-color,box-shadow,opacity,background-color] hover:border-border-strong',
        lane === 'needs_input' && 'border-stage-needs-input/55 ring-1 ring-stage-needs-input/25',
        lane === 'failed' && 'border-stage-failed/40',
        lane === 'discarded' && 'opacity-60',
        checked && 'border-primary/50 bg-primary/[0.06] hover:border-primary/70',
        selected && 'border-primary/70 ring-1 ring-primary/40',
        placeholder && 'opacity-35',
        overlay && 'cursor-grabbing shadow-2xl ring-1 ring-border-strong rotate-[1.2deg]',
        busy && 'opacity-80',
      )}
    >
      <div className="flex items-start gap-1.5">
        {onCheck && (
          <span className="mt-px flex h-[18px] shrink-0 items-center">
            <Checkbox
              checked={checked ?? false}
              aria-label={`Select #${task.number}`}
              onPointerDown={stop}
              onKeyDown={stop}
              onClick={(e) => {
                stop(e);
                onCheck(task, e.shiftKey);
              }}
              className="relative after:absolute after:-inset-1.5"
            />
          </span>
        )}
        <span className="mt-px shrink-0 font-mono text-[11px] leading-[18px] text-muted-foreground tabular">
          #{task.number}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 text-[13px] leading-[18px] font-medium break-words line-clamp-2',
            lane === 'discarded' && 'line-through',
          )}
          title={task.title}
        >
          {task.title}
        </span>
        {task.threadLink && (
          <Tip content="Open thread in T3">
            <a
              href={task.threadLink}
              target="_blank"
              rel="noreferrer"
              onPointerDown={stop}
              onClick={stop}
              className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-muted-foreground/70 opacity-70 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
              aria-label="Open thread in T3"
            >
              <SquareArrowOutUpRight className="size-3.5" />
            </a>
          </Tip>
        )}
      </div>

      {!compact && <TaskChips task={task} />}
      {!compact && <PipelineStrip task={task} />}
      <StatusLine task={task} board={board} activeTasks={activeTasks} pauseAll={pauseAll} />
      {!overlay && <CardActions task={task} lane={lane} />}
    </div>
  );
});

/** A card wired into dnd-kit. Cards in Running, Needs Input and AI Review are not draggable. */
export function SortableTaskCard({
  task,
  selected,
  checked,
  onCheck,
}: {
  task: TaskView;
  selected: boolean;
  checked?: boolean;
  onCheck?: CardProps['onCheck'];
}) {
  const { openTask } = useBoardContext();
  const lane = laneFor(task);
  const draggable = DRAGGABLE_LANES.has(lane);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', lane },
    disabled: { draggable: !draggable, droppable: false },
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onKeyDown={(e) => {
        // Enter opens the drawer; Space picks the card up (keyboard drag).
        if (e.key === 'Enter' && !isDragging) {
          e.preventDefault();
          openTask(task);
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
      aria-roledescription={draggable ? 'draggable task' : 'task'}
      className={cn(
        'rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
      )}
    >
      <TaskCard task={task} selected={selected} placeholder={isDragging} checked={checked} onCheck={onCheck} />
    </div>
  );
}
