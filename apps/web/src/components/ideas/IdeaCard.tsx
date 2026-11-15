import type { IdeaDifficulty, IdeaImpact, IdeaView } from '@t3-orchestra/shared';
import { ChevronDown, ChevronUp, Plus, SquareKanban, X } from 'lucide-react';
import { useId, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const IMPACT: Record<IdeaImpact, { label: string; variant: 'success' | 'info' | 'default'; tip: string }> = {
  high: { label: 'High', variant: 'success', tip: 'Clearly worth doing soon' },
  medium: { label: 'Medium', variant: 'info', tip: 'A real improvement' },
  low: { label: 'Low', variant: 'default', tip: 'Nice to have' },
};

const DIFFICULTY: Record<IdeaDifficulty, { label: string; variant: 'success' | 'warning' | 'destructive'; tip: string }> = {
  easy: { label: 'Easy', variant: 'success', tip: 'A few files, no open design questions' },
  medium: { label: 'Medium', variant: 'warning', tip: 'Several files or one decision to make' },
  hard: { label: 'Hard', variant: 'destructive', tip: 'Many files, design work, or risky' },
};

/** "Impact: High" / "Difficulty: Easy" chips; green is the good end of both. */
export function IdeaChips({ idea }: { idea: Pick<IdeaView, 'impact' | 'difficulty'> }) {
  const impact = IMPACT[idea.impact];
  const difficulty = DIFFICULTY[idea.difficulty];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Tip content={impact.tip}>
        <Badge variant={impact.variant}>
          <span className="font-normal opacity-75">Impact</span>
          {impact.label}
        </Badge>
      </Tip>
      <Tip content={difficulty.tip}>
        <Badge variant={difficulty.variant}>
          <span className="font-normal opacity-75">Difficulty</span>
          {difficulty.label}
        </Badge>
      </Tip>
    </div>
  );
}

export function IdeaCard({
  idea,
  adding,
  onAdd,
  onDismiss,
  onOpenTask,
}: {
  idea: IdeaView;
  adding: boolean;
  onAdd: () => void;
  onDismiss: () => void;
  onOpenTask: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const added = idea.status === 'added';
  const hasDetails = idea.details.trim() !== '' || idea.acceptanceCriteria.length > 0 || idea.touches.length > 0;

  return (
    <article
      className={cn(
        'flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3.5 transition-colors hover:border-border-strong',
        added && 'bg-card/60',
      )}
    >
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-[13.5px] leading-snug font-medium text-pretty">{idea.title}</h3>
        {!added && (
          <Tip content="Dismiss">
            <Button variant="ghost" size="icon-xs" className="-mt-0.5 -mr-1 text-muted-foreground" onClick={onDismiss} aria-label={`Dismiss: ${idea.title}`}>
              <X />
            </Button>
          </Tip>
        )}
      </div>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">{idea.description}</p>
      <IdeaChips idea={idea} />

      {open && (
        <div id={detailsId} className="flex flex-col gap-2.5 border-t border-border pt-2.5 text-[12.5px]">
          <Markdown className="text-[12.5px]">{idea.details}</Markdown>
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

      <div className="mt-auto flex items-center gap-2 pt-0.5">
        {hasDetails && (
          <Button variant="ghost" size="xs" className="-ml-1.5 text-muted-foreground" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={detailsId}>
            {open ? 'Less' : 'Details'}
            {open ? <ChevronUp /> : <ChevronDown />}
          </Button>
        )}
        <div className="ml-auto">
          {added ? (
            <Button variant="ghost" size="sm" onClick={onOpenTask} disabled={idea.taskNumber === null}>
              <SquareKanban />
              {idea.taskNumber === null ? 'On the board' : `#${idea.taskNumber} on the board`}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={onAdd} disabled={adding}>
              {adding ? <Spinner className="size-3.5" /> : <Plus />}
              Add to board
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
