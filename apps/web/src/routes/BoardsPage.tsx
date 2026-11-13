import { COLUMN_ORDER, type BoardView } from '@t3-orchestra/shared';
import { ArrowRight, GitBranch, Plus, Zap } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useBoards } from '@/api/boards';
import { errorMessage } from '@/api/client';
import { NewBoardDialog } from '@/components/boards/NewBoardDialog';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { LANE_LABELS, LANE_STYLE } from '@/lib/stage';
import { relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

function DistributionBar({ board }: { board: BoardView }) {
  const counts = board.counts.byColumn;
  const total = COLUMN_ORDER.reduce((s, c) => s + (counts[c] ?? 0), 0);
  if (total === 0) return <div className="h-1.5 rounded-full bg-muted" />;
  return (
    <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted">
      {COLUMN_ORDER.map((c) => {
        const n = counts[c] ?? 0;
        if (!n) return null;
        return (
          <Tip key={c} content={`${LANE_LABELS[c]}: ${n}`}>
            <span className={cn('h-full', LANE_STYLE[c].dot)} style={{ flexGrow: n }} />
          </Tip>
        );
      })}
    </div>
  );
}

function BoardCard({ board }: { board: BoardView }) {
  const c = board.counts;
  return (
    <Link
      to={`/b/${board.slug}`}
      className="group flex flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold tracking-tight">{board.name}</h2>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={board.projectPath}>
            {board.projectPath}
          </p>
        </div>
        <ArrowRight className="mt-0.5 size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <DistributionBar board={board} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1 font-mono text-[11px]">
          <GitBranch className="size-3" />
          {board.baseBranch}
        </span>
        <span>
          <span className="font-mono text-foreground tabular">{c.total}</span> tasks
        </span>
        <span>
          <span className={cn('font-mono tabular', c.active > 0 ? 'text-stage-running' : 'text-foreground')}>
            {c.active}/{board.maxParallel}
          </span>{' '}
          running
        </span>
        {c.needsYou > 0 && (
          <span className="font-medium text-stage-needs-input">
            <span className="font-mono tabular">{c.needsYou}</span> need you
          </span>
        )}
        {board.autoRun && (
          <span className="flex items-center gap-0.5 text-primary">
            <Zap className="size-3" />
            auto-run
          </span>
        )}
        <span className="ml-auto text-[11px]">{relativeTime(board.updatedAt)}</span>
      </div>
    </Link>
  );
}

export function BoardsPage() {
  const boards = useBoards();
  const [newOpen, setNewOpen] = useState(false);
  const list = boards.data ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppHeader />
      <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight">Boards</h1>
              <p className="text-[13px] text-muted-foreground">Each board runs tasks as T3 Code threads in their own worktrees.</p>
            </div>
            <Button onClick={() => setNewOpen(true)}>
              <Plus />
              New board
            </Button>
          </div>

          {boards.isLoading ? (
            <div className="grid gap-3 md:grid-cols-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-32" />
              ))}
            </div>
          ) : boards.isError ? (
            <div className="rounded-lg border border-border bg-card p-6 text-[13px] text-muted-foreground">
              Could not load boards: {errorMessage(boards.error)}
            </div>
          ) : list.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-16 text-center">
              <div className="grid grid-cols-3 gap-1 opacity-60" aria-hidden>
                <span className="h-10 w-3 rounded-sm bg-stage-running/60" />
                <span className="h-6 w-3 rounded-sm bg-stage-needs-input/60" />
                <span className="h-3 w-3 rounded-sm bg-stage-done/60" />
              </div>
              <p className="text-[14px] font-medium">No boards yet</p>
              <p className="max-w-sm text-[13px] text-muted-foreground">
                Point a board at a git repository. Plan from one big prompt, then let T3 Code agents work through the
                tasks.
              </p>
              <Button onClick={() => setNewOpen(true)}>
                <Plus />
                New board
              </Button>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {list.map((b) => (
                <BoardCard key={b.id} board={b} />
              ))}
            </div>
          )}
        </div>
      </main>
      <NewBoardDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
