// A marketing task: `build` ones go on the board like any idea; `do` ones are done by the team,
// usually with a draft (post, email) to copy.
import type { IdeaView } from '@t3-orchestra/shared';
import { Check, ChevronDown, ChevronUp, ClipboardCheck, Copy, Hammer, Plus, SquareKanban, Undo2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { IdeaChips } from '@/components/ideas/IdeaCard';
import { Markdown } from '@/components/Markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export const KIND_INFO = {
  build: { label: 'Build', icon: Hammer, variant: 'info', tip: 'A change to the code: add it to the board and an agent builds it' },
  do: { label: 'Do', icon: ClipboardCheck, variant: 'primary', tip: 'Something you do outside the code; any copy is drafted for you' },
} as const;

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error('Could not copy to the clipboard'),
    );
  return { copied, copy };
}

export function MarketingCard({
  idea,
  busy,
  onAdd,
  onDone,
  onDismiss,
  onOpenTask,
}: {
  idea: IdeaView;
  busy: boolean;
  onAdd: () => void;
  onDone: (undo: boolean) => void;
  onDismiss: () => void;
  onOpenTask: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const { copied, copy } = useCopy();
  const kind = KIND_INFO[idea.kind];
  const settled = idea.status === 'added' || idea.status === 'done';
  const draft = idea.draft.trim();
  const hasDetails = idea.details.trim() !== '' || draft !== '' || idea.acceptanceCriteria.length > 0 || idea.touches.length > 0;

  return (
    <article
      className={cn(
        'flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3.5 transition-colors hover:border-border-strong',
        settled && 'bg-card/60',
      )}
    >
      <div className="flex items-start gap-2">
        <h3 className={cn('min-w-0 flex-1 text-[13.5px] leading-snug font-medium text-pretty', idea.status === 'done' && 'text-muted-foreground line-through decoration-1')}>
          {idea.title}
        </h3>
        {!settled && (
          <Tip content="Dismiss">
            <Button variant="ghost" size="icon-xs" className="-mt-0.5 -mr-1 text-muted-foreground" onClick={onDismiss} aria-label={`Dismiss: ${idea.title}`}>
              <X />
            </Button>
          </Tip>
        )}
      </div>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">{idea.description}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tip content={kind.tip}>
          <Badge variant={kind.variant}>
            <kind.icon />
            {kind.label}
          </Badge>
        </Tip>
        <IdeaChips idea={idea} />
      </div>

      {open && (
        <div id={detailsId} className="flex flex-col gap-2.5 border-t border-border pt-2.5 text-[12.5px]">
          {idea.details.trim() && <Markdown className="text-[12.5px]">{idea.details}</Markdown>}
          {draft && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Draft</span>
                <Button variant="ghost" size="xs" className="-mr-1.5" onClick={() => void copy(draft)}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-background/50 px-2.5 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap scrollbar-thin">
                {draft}
              </div>
            </div>
          )}
          {idea.acceptanceCriteria.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Done when</span>
              <ul className="list-disc space-y-0.5 pl-4">
                {idea.acceptanceCriteria.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {idea.touches.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {idea.touches.map((p) => (
                <span key={p} className="rounded border border-border px-1.5 py-px font-mono text-[11px] break-all text-muted-foreground">
                  {p}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-auto flex items-center gap-1.5 pt-0.5">
        {hasDetails && (
          <Button variant="ghost" size="xs" className="-ml-1.5 text-muted-foreground" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={detailsId}>
            {open ? 'Less' : draft ? 'Details and draft' : 'Details'}
            {open ? <ChevronUp /> : <ChevronDown />}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {idea.kind === 'build' ? (
            idea.status === 'added' ? (
              <Button variant="ghost" size="sm" onClick={onOpenTask} disabled={idea.taskNumber === null}>
                <SquareKanban />
                {idea.taskNumber === null ? 'On the board' : `#${idea.taskNumber} on the board`}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={onAdd} disabled={busy}>
                {busy ? <Spinner className="size-3.5" /> : <Plus />}
                Add to board
              </Button>
            )
          ) : idea.status === 'done' ? (
            <Tip content="Mark as not done">
              <Button variant="ghost" size="sm" onClick={() => onDone(true)} disabled={busy}>
                <Undo2 />
                Done
              </Button>
            </Tip>
          ) : (
            <>
              {draft && !open && (
                <Tip content="Copy the draft">
                  <Button variant="ghost" size="icon-sm" onClick={() => void copy(draft)} aria-label={`Copy the draft: ${idea.title}`}>
                    {copied ? <Check /> : <Copy />}
                  </Button>
                </Tip>
              )}
              <Button variant="secondary" size="sm" onClick={() => onDone(false)} disabled={busy}>
                <Check />
                Mark done
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
