import type { TaskView } from '@t3-orchestra/shared';
import { html as diffToHtml, type Diff2HtmlConfig } from 'diff2html';
import { Columns2, FileDiff, GitBranch, RefreshCw, Rows2, TriangleExclamationPoint } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { errorMessage } from '@/api/client';
import { useTaskDiff } from '@/api/tasks';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/spinner';
import { readString, writeString } from '@/lib/storage';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import 'diff2html/bundles/css/diff2html.min.css';

type Format = 'line-by-line' | 'side-by-side';
const LARGE_PATCH = 1_500_000;

export function DiffViewer({ task }: { task: TaskView }) {
  const hasBranch = Boolean(task.branch || task.worktreePath || task.threadId);
  const diff = useTaskDiff(task.id, hasBranch);
  const { theme } = useTheme();
  const [format, setFormatState] = useState<Format>(() =>
    readString('diffFormat') === 'side-by-side' ? 'side-by-side' : 'line-by-line',
  );
  const [forceLarge, setForceLarge] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  const setFormat = (f: Format) => {
    writeString('diffFormat', f);
    setFormatState(f);
  };

  const patch = diff.data?.patch ?? '';
  const tooLarge = patch.length > LARGE_PATCH && !forceLarge;
  const rendered = useMemo(() => {
    if (!patch || tooLarge) return '';
    const config: Diff2HtmlConfig = {
      outputFormat: format,
      drawFileList: false,
      matching: 'lines',
      colorScheme: theme as NonNullable<Diff2HtmlConfig['colorScheme']>,
    };
    return diffToHtml(patch, config);
  }, [patch, format, theme, tooLarge]);

  const scrollToFile = (path: string) => {
    const root = container.current;
    if (!root) return;
    for (const wrapper of root.querySelectorAll<HTMLElement>('.d2h-file-wrapper')) {
      const name = wrapper.querySelector('.d2h-file-name')?.textContent ?? '';
      if (name.includes(path)) {
        wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
  };

  if (!hasBranch) {
    return <p className="text-[13px] text-muted-foreground">No branch yet — the diff appears once the task has started.</p>;
  }
  if (diff.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (diff.isError) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border p-3 text-[13px] text-muted-foreground">
        <TriangleExclamationPoint className="size-4 text-warning" />
        <span className="min-w-0 flex-1">Could not load the diff: {errorMessage(diff.error)}</span>
        <Button size="xs" variant="ghost" onClick={() => void diff.refetch()}>
          <RefreshCw />
          Retry
        </Button>
      </div>
    );
  }
  const d = diff.data;
  if (!d) return null;

  const added = d.files.reduce((s, f) => s + f.added, 0);
  const removed = d.files.reduce((s, f) => s + f.removed, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="flex items-center gap-1 font-mono text-muted-foreground">
          <GitBranch className="size-3.5" />
          {d.base}
          <span className="text-muted-foreground/60">…</span>
          {d.branch ?? task.branch ?? 'HEAD'}
          {d.head && <span className="text-muted-foreground/60">@{d.head.slice(0, 8)}</span>}
        </span>
        <span className="font-mono tabular">
          <span className="text-success">+{added}</span> <span className="text-destructive">−{removed}</span>
          <span className="text-muted-foreground"> · {d.files.length} files</span>
        </span>
        {d.behindBy > 0 && (
          <span className="rounded border border-warning/35 bg-warning/10 px-1.5 py-px text-warning">
            behind {d.base} by {d.behindBy} {d.behindBy === 1 ? 'commit' : 'commits'}
          </span>
        )}
        <div className="ml-auto flex items-center rounded-md border border-border p-0.5">
          <Button
            size="xs"
            variant={format === 'line-by-line' ? 'secondary' : 'ghost'}
            className="h-5 border-0"
            onClick={() => setFormat('line-by-line')}
            aria-pressed={format === 'line-by-line'}
          >
            <Rows2 />
            Unified
          </Button>
          <Button
            size="xs"
            variant={format === 'side-by-side' ? 'secondary' : 'ghost'}
            className="h-5 border-0"
            onClick={() => setFormat('side-by-side')}
            aria-pressed={format === 'side-by-side'}
          >
            <Columns2 />
            Split
          </Button>
        </div>
      </div>

      {d.uncommitted.length > 0 && (
        <div className="rounded-md border border-warning/35 bg-warning/10 p-2.5 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-warning">
            <TriangleExclamationPoint className="size-3.5" />
            {d.uncommitted.length} uncommitted {d.uncommitted.length === 1 ? 'change' : 'changes'} in the worktree
          </p>
          <p className="mt-0.5 text-muted-foreground">
            They are not part of the diff below and would block a local merge.
          </p>
          <ul className="mt-1.5 max-h-28 overflow-y-auto font-mono text-[11px] text-muted-foreground scrollbar-thin">
            {d.uncommitted.map((f) => (
              <li key={f} className="truncate">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.files.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-[13px] text-muted-foreground">
          No committed changes on the branch yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <ul className="max-h-56 divide-y divide-border overflow-y-auto scrollbar-thin">
            {d.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => scrollToFile(f.path)}
                  className="flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-accent"
                >
                  <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={f.path}>
                    {f.path}
                  </span>
                  {f.binary ? (
                    <span className="text-2xs text-muted-foreground">binary</span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular">
                      <span className="text-success">+{f.added}</span>
                      <span className="text-destructive">−{f.removed}</span>
                      <ChangeBar added={f.added} removed={f.removed} />
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tooLarge ? (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-[13px] text-muted-foreground">
          This diff is large ({Math.round(patch.length / 1_000_000)} MB).{' '}
          <Button size="xs" variant="secondary" onClick={() => setForceLarge(true)}>
            Render anyway
          </Button>
        </div>
      ) : rendered ? (
        <div ref={container} className={cn('diff-view min-w-0 overflow-x-auto')} dangerouslySetInnerHTML={{ __html: rendered }} />
      ) : null}
      {d.truncated && (
        <p className="text-center text-xs text-muted-foreground">
          The diff was cut off at the server's size limit. The file list above is complete; run{' '}
          <code className="font-mono">git diff {d.base}...HEAD</code> in the worktree for the rest.
        </p>
      )}
    </div>
  );
}

function ChangeBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  const blocks = 5;
  const green = total === 0 ? 0 : Math.round((added / total) * blocks);
  return (
    <span className="flex gap-px" aria-hidden>
      {Array.from({ length: blocks }, (_, i) => (
        <span
          key={i}
          className={cn('size-1.5 rounded-[1px]', total === 0 ? 'bg-border' : i < green ? 'bg-success' : 'bg-destructive')}
        />
      ))}
    </span>
  );
}
