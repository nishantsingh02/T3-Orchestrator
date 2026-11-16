import type { TaskDetailView, TaskView } from '@t3-orchestra/shared';
import { Palette } from 'lucide-react';
import { useBoardContext } from '@/components/board/BoardContext';
import { SectionTitle } from '@/components/drawer/OverviewTab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { findOption, openRound, optionKey, optionLabel, roundBadge } from './model';
import { ScaledFrame } from './ScaledFrame';

/**
 * The Review tab's design options: thumbnails of the round waiting for a pick (or of the latest one),
 * each opening the full-screen gallery at that option.
 */
export function DesignSection({ task, detail }: { task: TaskView; detail: TaskDetailView | null }) {
  const { openDesigns } = useBoardContext();
  const rounds = detail?.designRounds ?? [];
  if (!task.design || rounds.length === 0) return null;
  const open = openRound(task, rounds);
  const shown = open ?? rounds.at(-1)!;
  const badge = roundBadge(shown, open);
  const chosen = shown.choice?.picks.map((p) => findOption(rounds, p)).filter((o) => o !== undefined) ?? [];

  return (
    <section>
      <SectionTitle
        action={
          <Badge variant={badge.variant}>
            Round {shown.round} · {badge.label}
          </Badge>
        }
      >
        Design options
      </SectionTitle>
      <div className={cn('flex flex-col gap-3 rounded-md border bg-surface p-3', open ? 'border-stage-human-review/45' : 'border-border')}>
        {(shown.question || open) && (
          <p className="text-[13.5px] leading-relaxed">
            {shown.question ?? 'Which option should the agent build?'}
            {open && (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Pick one, or several to combine, or ask for another round. Nothing is built until you choose.
              </span>
            )}
          </p>
        )}
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {shown.options.map((o) => {
            const picked = chosen.some((c) => optionKey(c) === optionKey(o));
            return (
              <li key={o.file} className="min-w-0">
                <button
                  type="button"
                  onClick={() => openDesigns(task, o)}
                  title={o.summary || o.title}
                  className={cn(
                    'group block w-full overflow-hidden rounded-md border bg-background text-left transition-colors hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                    picked ? 'border-success/50' : 'border-border',
                  )}
                >
                  <ScaledFrame src={o.url} title={optionLabel(o)} width={1280} interactive={false} className="aspect-[16/10] w-full" />
                  <span className="flex items-center gap-1.5 border-t border-border px-2 py-1 text-[11.5px] text-muted-foreground group-hover:text-foreground">
                    <span className="font-mono font-semibold">{o.letter}</span>
                    <span className="truncate">{o.title}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {!open && shown.choice && (
          <p className="text-xs text-muted-foreground">
            {shown.status === 'chosen' ? 'You chose ' : 'You asked for more, based on '}
            {chosen.length ? chosen.map((o) => `${optionLabel(o)} (round ${o.round})`).join(' + ') : 'your notes'}.
          </p>
        )}
        {/* While a pick is pending, the drawer header and banner already offer "Pick a design". */}
        {!open && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => openDesigns(task)}>
              <Palette />
              View options
            </Button>
            {rounds.length > 1 && <span className="text-xs text-muted-foreground">{rounds.length} rounds</span>}
          </div>
        )}
      </div>
    </section>
  );
}
