// "Open in VS Code" for the board toolbar (root checkout) and the task drawer (the task's worktree).
import type { BoardView, TaskView } from '@t3-orchestra/shared';
import { SquareCode } from 'lucide-react';
import { useOpenInVsCode } from '@/api/projectRuns';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';

export function OpenInVsCodeButton({ board, task, compact }: { board: BoardView; task?: TaskView; compact?: boolean }) {
  const open = useOpenInVsCode();
  const what = task ? `task #${task.number}'s worktree` : 'the project';
  const icon = open.isPending ? <Spinner className="size-3.5 text-current" /> : <SquareCode />;
  return (
    <Tip content={`Open ${what} in VS Code`}>
      <Button
        variant="secondary"
        size={compact ? 'icon-sm' : 'sm'}
        disabled={open.isPending}
        onClick={() => open.mutate({ boardId: board.id, taskId: task?.id ?? null })}
        aria-label="Open in VS Code"
      >
        {icon}
        {!compact && <span className="hidden sm:inline">VS Code</span>}
      </Button>
    </Tip>
  );
}
