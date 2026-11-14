import type { BoardView, TaskAction, TaskView } from '@t3-orchestra/shared';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Ellipsis,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  ListStart,
  Palette,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash,
} from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { usePatchTask } from '@/api/tasks';
import { useOptionalBoardContext } from '@/components/board/BoardContext';
import { currentThreadLink } from '@/components/tasks/TaskCard';
import { useActionPending, type useTaskActions } from '@/components/tasks/useTaskActions';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { laneFor } from '@/lib/stage';

type Run = ReturnType<typeof useTaskActions>['run'];

interface Props {
  task: TaskView;
  board: BoardView;
  run: Run;
  /** Called after "Edit & retry" moves a failed task back to the Backlog. */
  onEdit?: () => void;
  /** Show every applicable action as a button (Review tab) instead of primary + overflow. */
  expanded?: boolean;
}

function ActionButton({
  task,
  action,
  icon,
  children,
  onClick,
  ...props
}: Omit<ButtonProps, 'onClick'> & { task: TaskView; action: TaskAction; icon: ReactNode; onClick: () => void }) {
  const pending = useActionPending(task.id, action);
  return (
    <Button size="sm" disabled={pending} onClick={onClick} {...props}>
      {pending ? <Spinner className="size-3.5 text-current" /> : icon}
      {children}
    </Button>
  );
}

function approveLabel(board: BoardView): string {
  if (board.mergeStrategy === 'manual') return 'Approve';
  return 'Approve & merge';
}

export function StageActions({ task, board, run, onEdit, expanded = false }: Props) {
  const boardCtx = useOptionalBoardContext();
  const patchTask = usePatchTask();
  const lane = laneFor(task);
  const link = currentThreadLink(task);
  const opts = { board };
  const primary: ReactNode[] = [];
  const overflow: Array<{ label: string; icon: ReactNode; onSelect: () => void; destructive?: boolean }> = [];

  const discard = { label: 'Discard', icon: <Trash />, onSelect: () => void run(task, 'discard', {}, { confirm: true }), destructive: true };

  switch (task.stage) {
    case 'backlog':
    case 'ready':
      primary.push(
        <ActionButton key="start" task={task} action="start" icon={<Play />} onClick={() => void run(task, 'start')}>
          Start
        </ActionButton>,
        task.stage === 'backlog' ? (
          <ActionButton
            key="ready"
            variant="secondary"
            task={task}
            action="move-to-ready"
            icon={<ArrowRight />}
            onClick={() => void run(task, 'move-to-ready')}
          >
            Move to Ready
          </ActionButton>
        ) : (
          <ActionButton
            key="backlog"
            variant="secondary"
            task={task}
            action="move-to-backlog"
            icon={<ArrowLeft />}
            onClick={() => void run(task, 'move-to-backlog')}
          >
            Move to Backlog
          </ActionButton>
        ),
      );
      if (task.stage === 'ready') {
        overflow.push({
          label: task.runNext ? "Don't run next" : 'Run next',
          icon: <ListStart />,
          onSelect: () => patchTask.mutate({ task, patch: { runNext: !task.runNext } }),
        });
      }
      overflow.push(discard);
      break;

    case 'implementing':
    case 'ai_review':
      break;

    case 'human_review': {
      if (task.stageReason === 'design_options') {
        // Nothing is built yet: the decision is the design pick.
        if (boardCtx) {
          primary.push(
            <Button key="design" size="sm" onClick={() => boardCtx.openDesigns(task)}>
              <Palette />
              Pick a design
            </Button>,
          );
        }
        overflow.push({ label: 'Mark done', icon: <Check />, onSelect: () => void run(task, 'mark-done', {}, { ...opts, confirm: true }) }, discard);
        break;
      }
      if (board.mergeStrategy === 'pr') {
        if (task.stageReason !== 'pr_opened' && !task.prUrl) {
          primary.push(
            <ActionButton key="pr" task={task} action="open-pr" icon={<GitPullRequest />} onClick={() => void run(task, 'open-pr', {}, opts)}>
              Open PR
            </ActionButton>,
          );
        }
      } else {
        primary.push(
          <ActionButton
            key="approve"
            task={task}
            action="approve"
            icon={<GitMerge />}
            onClick={() => void run(task, 'approve', {}, { ...opts, confirm: true, noOptimistic: true })}
          >
            {approveLabel(board)}
          </ActionButton>,
        );
      }
      if (task.stageReason === 'merge_conflict') {
        primary.push(
          <ActionButton
            key="update"
            variant="warning"
            task={task}
            action="update-branch"
            icon={<RefreshCw />}
            onClick={() => void run(task, 'update-branch')}
          >
            Update branch
          </ActionButton>,
        );
      }
      primary.push(
        <ActionButton
          key="done"
          variant={board.mergeStrategy === 'pr' && (task.prUrl || task.stageReason === 'pr_opened') ? 'default' : 'secondary'}
          task={task}
          action="mark-done"
          icon={<Check />}
          onClick={() => void run(task, 'mark-done', {}, { ...opts, confirm: true })}
        >
          Mark done
        </ActionButton>,
      );
      const rerun = {
        label: 'Re-run AI review',
        icon: <Sparkles />,
        onSelect: () => void run(task, 'rerun-review'),
      };
      if (expanded || task.stageReason === 'review_failed') {
        primary.push(
          <ActionButton
            key="rerun"
            variant="secondary"
            task={task}
            action="rerun-review"
            icon={<Sparkles />}
            onClick={rerun.onSelect}
          >
            Re-run AI review
          </ActionButton>,
        );
      } else {
        overflow.push(rerun);
      }
      overflow.push(discard);
      break;
    }

    case 'failed':
      primary.push(
        <ActionButton key="resume" task={task} action="resume" icon={<RotateCcw />} onClick={() => void run(task, 'resume')}>
          Resume
        </ActionButton>,
        <ActionButton
          key="fresh"
          variant="secondary"
          task={task}
          action="retry-fresh"
          icon={<RefreshCw />}
          onClick={() => void run(task, 'retry-fresh', {}, { confirm: true })}
        >
          Retry fresh
        </ActionButton>,
      );
      overflow.push(
        {
          label: 'Edit & retry (move to Backlog)',
          icon: <Pencil />,
          onSelect: () => {
            void run(task, 'move-to-backlog').then((t) => t && onEdit?.());
          },
        },
        discard,
      );
      break;

    case 'done':
      if (task.prUrl) {
        primary.push(
          <Button key="pr" size="sm" variant="secondary" asChild>
            <a href={task.prUrl} target="_blank" rel="noreferrer">
              <GitPullRequest />
              View PR
            </a>
          </Button>,
        );
      }
      overflow.push(discard);
      break;

    case 'discarded':
      break;
  }

  if (link && (lane === 'needs_input' || lane === 'running' || lane === 'ai_review')) {
    primary.unshift(
      <Button key="t3" size="sm" variant={lane === 'needs_input' ? 'warning' : 'secondary'} asChild>
        <a href={link} target="_blank" rel="noreferrer">
          <ExternalLink />
          Open in T3
        </a>
      </Button>,
    );
  }

  if (expanded) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {primary}
        {overflow.map((o) => (
          <Button
            key={o.label}
            size="sm"
            variant={o.destructive ? 'destructive-outline' : 'secondary'}
            onClick={o.onSelect}
          >
            {o.icon}
            {o.label}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {primary}
      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="More actions">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {overflow.map((o, i) => (
              <Fragment key={o.label}>
                {o.destructive && i > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem variant={o.destructive ? 'destructive' : 'default'} onSelect={o.onSelect}>
                  {o.icon}
                  {o.label}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
