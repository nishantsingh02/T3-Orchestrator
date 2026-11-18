// "Run project" control for the board toolbar (root checkout) and the task drawer (the task's worktree).
// Run starts the best detected way at once and opens the panel; the caret opens it to choose.
import { isLiveRunStatus, type BoardView, type TaskView } from '@t3-orchestra/shared';
import { ChevronDown, ExternalLink, Play, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isApiError } from '@/api/client';
import { openRunPanels, targetKey, useStartRun, useStopRun, useTargetRun } from '@/api/projectRuns';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { RunPanel, shortUrl, StatusDot, stopHint, type RunPanelView } from './RunPanel';

export function RunButton({ board, task }: { board: BoardView; task?: TaskView }) {
  const target = useMemo(() => ({ boardId: board.id, taskId: task?.id ?? null }), [board.id, task?.id]);
  const run = useTargetRun(target);
  const start = useStartRun();
  const stop = useStopRun();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<RunPanelView>('run');
  const anchorRef = useRef<HTMLDivElement>(null);
  const live = run !== null && isLiveRunStatus(run.status);

  useEffect(() => {
    const key = targetKey(target);
    if (open) openRunPanels.add(key);
    else openRunPanels.delete(key);
    return () => void openRunPanels.delete(key);
  }, [open, target]);

  const runBest = () => {
    setView('run');
    setOpen(true);
    start.mutate({ target }, { onError: (err) => isApiError(err, 'NOTHING_TO_RUN') && setView('choose') });
  };
  const toggle = (next: RunPanelView) => {
    setView(next);
    setOpen((o) => !o || view !== next);
  };

  const what = task ? `task #${task.number}'s worktree` : 'the project';
  const failed = run?.status === 'failed';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div ref={anchorRef} className="flex items-center">
          {live ? (
            <>
              <Tip
                content={
                  open
                    ? undefined
                    : run.url
                      ? `Running${run.background ? ' in the background' : ''} at ${run.url}`
                      : `${run.recipe.label}: show output`
                }
              >
                <Button
                  variant="secondary"
                  size="sm"
                  className="max-w-56 rounded-r-none"
                  onClick={() => toggle('run')}
                  aria-label="Show the run"
                >
                  <StatusDot run={run} />
                  <span className="truncate font-mono text-[11.5px]">
                    {run.stopping ? 'Stopping…' : run.url ? shortUrl(run.url) : run.status === 'starting' ? 'Starting…' : 'Running'}
                  </span>
                </Button>
              </Tip>
              {run.url && (
                <Tip content="Open in the browser">
                  <Button variant="secondary" size="icon-sm" className="-ml-px rounded-none" asChild>
                    <a href={run.url} target="_blank" rel="noreferrer" aria-label="Open in the browser">
                      <ExternalLink />
                    </a>
                  </Button>
                </Tip>
              )}
              <Tip content={stopHint(run)}>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="-ml-px rounded-l-none"
                  disabled={stop.isPending || run.stopping}
                  onClick={() => stop.mutate(run)}
                  aria-label="Stop"
                >
                  {stop.isPending || run.stopping ? <Spinner className="size-3.5" /> : <Square className="size-3! fill-current" />}
                </Button>
              </Tip>
            </>
          ) : (
            <>
              <Tip content={open ? undefined : `Run ${what}: T3 Orchestra picks the best way and gives you the link`}>
                <Button variant="secondary" size="sm" className="rounded-r-none" disabled={start.isPending} onClick={runBest}>
                  {start.isPending ? <Spinner className="size-3.5 text-current" /> : <Play />}
                  Run
                </Button>
              </Tip>
              <Tip content={open ? undefined : failed ? 'The last run failed: see why, or choose how to run it' : 'Choose how to run it'}>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="relative -ml-px w-6 rounded-l-none"
                  onClick={() => toggle(run ? 'run' : 'choose')}
                  aria-label="Run options"
                >
                  <ChevronDown />
                  {failed && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-destructive" />}
                </Button>
              </Tip>
            </>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        sideOffset={6}
        className={cn('w-[min(560px,calc(100vw-1.5rem))] overflow-hidden p-0')}
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Starting a run swaps the focused Run button for the live controls, and the drawer's focus trap
        // then moves focus; that must not close the panel. Clicks outside and Esc still do.
        onFocusOutside={(e) => e.preventDefault()}
        // The buttons above toggle the panel themselves.
        onPointerDownOutside={(e) => anchorRef.current?.contains(e.target as Node) && e.preventDefault()}
      >
        <RunPanel
          target={target}
          board={board}
          title={task ? `#${task.number}` : board.name}
          run={run}
          view={view}
          onView={setView}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
