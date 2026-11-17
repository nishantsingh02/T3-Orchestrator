// The board's context files: what each one is (the user's description, or else the agent's
// one-liner), whether it is in the graph yet, and the way to describe, open, focus or remove it.
import type { KnowledgeFileView } from '@t3-orchestra/shared';
import { Crosshair, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { FILE_ICONS, fileSize } from './model';

function StatusText({ f }: { f: KnowledgeFileView }) {
  if (f.reading) {
    return (
      <span className="inline-flex items-center gap-1 text-primary">
        <Spinner className="size-3" /> Reading
      </span>
    );
  }
  if (f.status === 'pending') return <span className="text-warning">Not in the graph yet</span>;
  if (f.status === 'skipped') return <span className="text-destructive">Could not be read</span>;
  return (
    <span>
      {f.nodeCount} node{f.nodeCount === 1 ? '' : 's'}
    </span>
  );
}

export function FileList({
  files,
  focused,
  onFocus,
  onDescribe,
  onRemove,
}: {
  files: KnowledgeFileView[];
  focused: string | null;
  onFocus: (id: string | null) => void;
  onDescribe: (f: KnowledgeFileView) => void;
  onRemove: (f: KnowledgeFileView) => void;
}) {
  const confirm = useConfirm();
  const remove = async (f: KnowledgeFileView) => {
    const ok = await confirm({
      title: `Remove ${f.name}?`,
      description:
        f.nodeCount > 0
          ? `What only this file says (${f.nodeCount} node${f.nodeCount === 1 ? '' : 's'} cite it) leaves the graph, and agents stop seeing it. The file is deleted from the project folder.`
          : 'The file is deleted from the project folder.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (ok) onRemove(f);
  };

  return (
    <ul className="flex flex-col gap-0.5">
      {files.map((f) => {
        const Icon = FILE_ICONS[f.kind];
        const on = focused === f.id;
        // Why it was skipped matters most; then the user's own words, which they recognize the file by.
        const about = f.status === 'skipped' ? f.note : (f.description ?? f.summary);
        const theirs = f.status !== 'skipped' && Boolean(f.description);
        return (
          <li key={f.id} className={cn('group relative rounded-md transition-colors hover:bg-accent', on && 'bg-accent')}>
            <button
              type="button"
              onClick={() => onFocus(on ? null : f.id)}
              aria-pressed={on}
              className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', on ? 'text-primary' : 'text-muted-foreground')} />
              <span className="min-w-0 flex-1">
                {/* Room for the buttons, which sit on this line. */}
                <span className={cn('block truncate text-[13px] font-medium', f.nodeCount > 0 ? 'pr-23' : 'pr-17')}>{f.name}</span>
                <span className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-muted-foreground">
                  <span className="tabular">{fileSize(f.size)}</span>
                  <span aria-hidden>·</span>
                  <StatusText f={f} />
                </span>
                {about && (
                  <span
                    title={theirs ? 'Your description' : undefined}
                    className={cn('mt-0.5 line-clamp-2 block text-[11.5px] leading-snug whitespace-pre-line', theirs ? 'text-foreground/75' : 'text-muted-foreground')}
                  >
                    {about}
                  </span>
                )}
              </span>
            </button>
            <span className="absolute top-1 right-1 flex items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
              {f.nodeCount > 0 && (
                <Tip content={on ? 'Show the whole graph' : 'Show its nodes in the graph'}>
                  <Button variant="ghost" size="icon-xs" aria-label={`Show the nodes from ${f.name}`} aria-pressed={on} onClick={() => onFocus(on ? null : f.id)}>
                    <Crosshair />
                  </Button>
                </Tip>
              )}
              <Tip content={f.description ? 'Edit the description' : 'Describe it for the agents'}>
                <Button variant="ghost" size="icon-xs" aria-label={`Describe ${f.name}`} onClick={() => onDescribe(f)}>
                  <Pencil />
                </Button>
              </Tip>
              <Tip content="Open">
                <Button variant="ghost" size="icon-xs" asChild>
                  <a href={f.url} target="_blank" rel="noreferrer" aria-label={`Open ${f.name}`}>
                    <ExternalLink />
                  </a>
                </Button>
              </Tip>
              <Tip content="Remove">
                <Button variant="ghost" size="icon-xs" aria-label={`Remove ${f.name}`} className="hover:text-destructive" onClick={() => void remove(f)}>
                  <Trash2 />
                </Button>
              </Tip>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
