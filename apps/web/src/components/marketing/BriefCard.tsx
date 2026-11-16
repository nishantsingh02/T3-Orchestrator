// "What you're marketing": the board's marketing brief, which every Marketing generation reads.
// When it is empty the agent writes one from the code, offered here to keep.
import type { BoardView } from '@t3-orchestra/shared';
import { Pencil, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { usePatchBoard } from '@/api/boards';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';

export function BriefCard({ board, suggestion }: { board: BoardView; suggestion: string | null }) {
  const patch = usePatchBoard();
  const [draft, setDraft] = useState<string | null>(null);
  const brief = board.marketingBrief.trim();
  const save = (text: string) => patch.mutate({ board, patch: { marketingBrief: text.trim() } }, { onSuccess: () => setDraft(null) });

  return (
    <section className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3.5" aria-labelledby="marketing-brief">
      <div className="flex items-center gap-2">
        <h2 id="marketing-brief" className="min-w-0 flex-1 text-[13.5px] font-medium">
          What you're marketing
        </h2>
        {draft === null && brief && (
          <Button variant="ghost" size="xs" onClick={() => setDraft(board.marketingBrief)}>
            <Pencil />
            Edit
          </Button>
        )}
      </div>

      {draft !== null ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save(draft);
          }}
        >
          <Textarea
            autoFocus
            rows={6}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Marketing brief"
            placeholder={'What it is, in one line.\nWho it is for.\nWhy they would pick it over the alternatives.\nWhere they hang out (subreddits, communities, newsletters).'}
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={patch.isPending}>
              Save
            </Button>
          </div>
        </form>
      ) : brief ? (
        <Markdown className="text-[12.5px]">{brief}</Markdown>
      ) : suggestion ? (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="size-3.5 text-primary" />
            The agent wrote this from the code. Keep it, or fix it first.
          </p>
          <div className="rounded-md border border-border bg-background/40 px-3 py-2">
            <Markdown className="text-[12.5px]">{suggestion}</Markdown>
          </div>
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setDraft(suggestion)}>
              Edit first
            </Button>
            <Button size="sm" onClick={() => save(suggestion)} disabled={patch.isPending}>
              Use this brief
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[12.5px] text-muted-foreground">
            Tell the Marketing agent what the product is, who it's for and why they'd pick it. Leave it empty and the agent works it out from the
            code the first time it runs.
          </p>
          <Button variant="secondary" size="sm" onClick={() => setDraft('')}>
            <Pencil />
            Write the brief
          </Button>
        </div>
      )}
    </section>
  );
}
