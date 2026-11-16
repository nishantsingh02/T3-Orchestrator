// Imports from T3 Code history: an agent reads the project's T3 threads and code and writes the
// project context into the board brief. The banner says how the latest import is doing (and, once,
// that it finished); the dialog shows what it wrote.
import type { BoardView, ProjectImportView } from '@t3-orchestra/shared';
import { BookOpenText, History, ListTodo, MessageCircleQuestion, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { useImportFromT3 } from '@/api/boards';
import { OpenInT3 } from '@/components/ideas/IdeasView';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { readJson, writeJson } from '@/lib/storage';
import { absoluteTime, formatDuration, relativeTime, toMs, useNow } from '@/lib/time';
import { cn } from '@/lib/utils';

export const isImportOpen = (i: ProjectImportView | null | undefined) => i?.status === 'gathering' || i?.status === 'running' || i?.status === 'waiting';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The plan composer's prompt for "Plan next steps". */
export function nextStepsPrompt(i: ProjectImportView): string {
  return [
    'Plan the next steps for this project, as found by the import of its T3 Code history:',
    i.nextSteps.map((s, n) => `${n + 1}. ${s}`).join('\n'),
    'The project context in the board brief has the details.',
  ].join('\n\n');
}

const seenKey = (i: ProjectImportView) => `importSeen:${i.id}`;
/** A finished import is announced once, and only for a day. */
const DONE_BANNER_MS = 24 * 3600_000;

export function ImportBanner({ board, onView, onPlan }: { board: BoardView; onView: () => void; onPlan: (prompt: string) => void }) {
  const now = useNow();
  const imp = board.projectImport;
  const retry = useImportFromT3();
  const [, rerender] = useState(0);
  if (!imp) return null;
  const box = 'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 text-[13px]';
  const elapsed = <span className="ml-2 font-mono text-xs text-muted-foreground tabular">{formatDuration(now - (toMs(imp.createdAt) ?? now))}</span>;

  if (imp.status === 'gathering' || imp.status === 'running') {
    return (
      <div className={cn(box, 'border-border bg-card')} aria-live="polite">
        <Spinner className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          {imp.status === 'gathering'
            ? "Collecting the project's T3 threads…"
            : imp.threadCount > 0
              ? `An agent is reading ${plural(imp.threadCount, 'T3 thread')} and the code to learn what the project is and where it stands…`
              : 'An agent is reading the code to learn what the project is and where it stands…'}
          {elapsed}
        </span>
        <OpenInT3 link={imp.threadLink} />
      </div>
    );
  }
  if (imp.status === 'waiting') {
    return (
      <div className={cn(box, 'border-warning/35 bg-warning/10')} aria-live="polite">
        <MessageCircleQuestion className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">The import agent is waiting for you in T3. Answer it there and it carries on here.</span>
        <OpenInT3 link={imp.threadLink} variant="warning" />
      </div>
    );
  }
  if (imp.status === 'failed') {
    return (
      <div className={cn(box, 'border-destructive/35 bg-destructive/8')} role="alert">
        <TriangleAlert className="size-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">Could not learn about the project from T3.</span>{' '}
          <span className="text-muted-foreground">{imp.error}</span>
        </span>
        <OpenInT3 link={imp.threadLink} />
        <Button variant="secondary" size="sm" onClick={() => retry.mutate(board)} disabled={retry.isPending}>
          <RotateCcw />
          Try again
        </Button>
      </div>
    );
  }

  const finished = toMs(imp.finishedAt) ?? 0;
  if (readJson<boolean>(seenKey(imp), false) || now - finished > DONE_BANNER_MS) return null;
  const dismiss = () => {
    writeJson(seenKey(imp), true);
    rerender((n) => n + 1);
  };
  return (
    <div className={cn(box, 'border-success/35 bg-success/8')} aria-live="polite">
      <BookOpenText className="size-4 shrink-0 text-success" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">Project context ready.</span> <span className="text-muted-foreground">{imp.summary}</span>
      </span>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          dismiss();
          onView();
        }}
      >
        View
      </Button>
      {imp.nextSteps.length > 0 && (
        <Button
          size="sm"
          onClick={() => {
            dismiss();
            onPlan(nextStepsPrompt(imp));
          }}
        >
          <ListTodo />
          Plan next steps
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" onClick={dismiss} aria-label="Dismiss">
        <X />
      </Button>
    </div>
  );
}

/** What the latest import wrote into the brief, with Re-import and Plan next steps. */
export function ProjectContextDialog({
  board,
  open,
  onOpenChange,
  onPlan,
  onEditBrief,
}: {
  board: BoardView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPlan: (prompt: string) => void;
  onEditBrief: () => void;
}) {
  const imp = board.projectImport;
  const again = useImportFromT3();
  const running = isImportOpen(imp);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Project context</DialogTitle>
          <DialogDescription>
            {imp?.status === 'done' ? (
              <>
                Learned from {plural(imp.threadCount, 'T3 thread')} and the code,{' '}
                <span title={absoluteTime(imp.finishedAt)}>{relativeTime(imp.finishedAt)}</span>. It's in the board brief, which every agent on
                this board reads first.
              </>
            ) : (
              'What an agent learned about the project from its T3 threads and the code.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border bg-surface px-4 py-3 scrollbar-thin">
          {imp?.text ? (
            <Markdown className="text-[13px]">{imp.text}</Markdown>
          ) : (
            <p className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
              {running ? <Spinner className="size-4" /> : <History className="size-4" />}
              {running ? 'The agent is still reading the threads.' : 'Nothing imported yet.'}
            </p>
          )}
        </div>
        <DialogFooter className="items-center">
          <div className="mr-auto flex gap-1">
            <OpenInT3 link={imp?.threadLink ?? null} />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onEditBrief();
              }}
            >
              Edit brief
            </Button>
          </div>
          <Button variant="secondary" onClick={() => again.mutate(board)} disabled={running || again.isPending}>
            {running || again.isPending ? <Spinner className="size-3.5" /> : <RotateCcw />}
            {imp ? 'Import again' : 'Import from T3'}
          </Button>
          {imp?.status === 'done' && imp.nextSteps.length > 0 && (
            <Button
              onClick={() => {
                onOpenChange(false);
                onPlan(nextStepsPrompt(imp));
              }}
            >
              <ListTodo />
              Plan next steps
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
