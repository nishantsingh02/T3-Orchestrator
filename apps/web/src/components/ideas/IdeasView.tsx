// Ideas: pick a category, and a read-only agent reads the project and proposes ideas for it, each with
// its impact and difficulty. "Add to board" puts an idea in the Backlog. Categories on the left, the
// chosen one's ideas on the right; the category is in the URL (?category=…) and remembered per board.
import type { IdeaBatchView, IdeaCategory, IdeaView } from '@t3-orchestra/shared';
import { IDEA_CATEGORIES } from '@t3-orchestra/shared';
import { ChevronDown, ExternalLink, Lightbulb, MessageCircleQuestion, RotateCcw, Sparkles, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { useAddIdea, useDismissIdea, useGenerateIdeas, useIdeas } from '@/api/ideas';
import { useBoardContext } from '@/components/board/BoardContext';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton, Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { readString, writeString } from '@/lib/storage';
import { absoluteTime, formatDuration, relativeTime, toMs, useNow } from '@/lib/time';
import { cn } from '@/lib/utils';
import { CATEGORY_INFO, isIdeaCategory } from './categories';
import { IdeaCard } from './IdeaCard';

export const isOpen = (b: IdeaBatchView | undefined) => b?.status === 'generating' || b?.status === 'waiting';

interface CategoryState {
  latest: IdeaBatchView | undefined;
  fresh: number;
}

function CategoryStatus({ state }: { state: CategoryState }) {
  if (isOpen(state.latest)) {
    return state.latest!.status === 'waiting' ? (
      <MessageCircleQuestion className="size-3.5 text-warning" aria-label="Waiting for you in T3" />
    ) : (
      <Spinner className="size-3.5" aria-label="Generating" />
    );
  }
  if (state.latest?.status === 'failed') return <TriangleAlert className="size-3.5 text-destructive" aria-label="Last generation failed" />;
  if (state.fresh > 0) return <span className="font-mono text-[11px] text-muted-foreground tabular">{state.fresh}</span>;
  return null;
}

function CategoryRail({
  states,
  selected,
  onSelect,
}: {
  states: Record<IdeaCategory, CategoryState>;
  selected: IdeaCategory;
  onSelect: (c: IdeaCategory) => void;
}) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface/40 md:flex">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
        <span className="text-xs font-medium text-muted-foreground">Categories</span>
      </div>
      <nav aria-label="Idea categories" className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin">
        <ul className="flex flex-col gap-0.5">
          {IDEA_CATEGORIES.map((c) => {
            const { label, icon: Icon } = CATEGORY_INFO[c];
            return (
              <li key={c}>
                <button
                  type="button"
                  onClick={() => onSelect(c)}
                  aria-current={c === selected ? 'page' : undefined}
                  className={cn(
                    'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                    c === selected ? 'bg-accent font-medium text-foreground' : 'text-foreground/85',
                  )}
                >
                  <Icon className={cn('size-4 shrink-0', c === selected ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <CategoryStatus state={states[c]} />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <p className="shrink-0 border-t border-border px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
        Pick a category and generate ideas. Add the ones you like to the Backlog.
      </p>
    </aside>
  );
}

/** Category picker for narrow screens, where the rail is hidden. */
function CategoryDropdown({
  states,
  selected,
  onSelect,
}: {
  states: Record<IdeaCategory, CategoryState>;
  selected: IdeaCategory;
  onSelect: (c: IdeaCategory) => void;
}) {
  const { label, icon: Icon } = CATEGORY_INFO[selected];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-1.5 min-w-0 md:hidden" aria-label={`Category: ${label}`}>
          <Icon className="text-primary" />
          <span className="truncate text-[13px] font-medium">{label}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Categories</DropdownMenuLabel>
        {IDEA_CATEGORIES.map((c) => {
          const info = CATEGORY_INFO[c];
          return (
            <DropdownMenuItem key={c} onSelect={() => onSelect(c)} className={cn(c === selected && 'bg-accent')}>
              <info.icon />
              <span className="min-w-0 flex-1 truncate">{info.label}</span>
              <CategoryStatus state={states[c]} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function OpenInT3({ link, variant = 'ghost' }: { link: string | null; variant?: 'ghost' | 'warning' }) {
  if (!link) return null;
  return (
    <Button variant={variant} size="sm" asChild>
      <a href={link} target="_blank" rel="noreferrer">
        <ExternalLink />
        Open in T3
      </a>
    </Button>
  );
}

/** What the category's latest generation is doing, or how it ended when that needs saying. */
export function BatchStatus({
  batch,
  label,
  onRetry,
  retrying,
  noun = 'ideas',
  working,
}: {
  batch: IdeaBatchView | undefined;
  label: string;
  onRetry: () => void;
  retrying: boolean;
  /** What a generation makes ("ideas", "tasks"). */
  noun?: string;
  /** The sentence while it runs; defaults to the Ideas one. */
  working?: string;
}) {
  const now = useNow();
  if (!batch) return null;
  const box = 'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 text-[13px]';
  if (batch.status === 'generating') {
    return (
      <div className={cn(box, 'border-border bg-card')} aria-live="polite">
        <Spinner className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          {working ?? `The agent is reading the code for ideas on ${label.toLowerCase()}…`}
          <span className="ml-2 font-mono text-xs text-muted-foreground tabular">{formatDuration(now - (toMs(batch.createdAt) ?? now))}</span>
        </span>
        <OpenInT3 link={batch.threadLink} />
      </div>
    );
  }
  if (batch.status === 'waiting') {
    return (
      <div className={cn(box, 'border-warning/35 bg-warning/10')} aria-live="polite">
        <MessageCircleQuestion className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">The agent is waiting for you in T3. Answer it there and it carries on here.</span>
        <OpenInT3 link={batch.threadLink} variant="warning" />
      </div>
    );
  }
  if (batch.status === 'failed') {
    return (
      <div className={cn(box, 'border-destructive/35 bg-destructive/8')} role="alert">
        <TriangleAlert className="size-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">Could not generate {noun}.</span>{' '}
          <span className="text-muted-foreground">{batch.error}</span>
        </span>
        <OpenInT3 link={batch.threadLink} />
        <Button variant="secondary" size="sm" onClick={onRetry} disabled={retrying}>
          <RotateCcw />
          Try again
        </Button>
      </div>
    );
  }
  if (batch.ideaCount === 0) {
    return (
      <div className={cn(box, 'border-border bg-card')}>
        <Lightbulb className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">No new {noun} this time.</span> {batch.summary && <span className="text-muted-foreground">{batch.summary}</span>}
        </span>
      </div>
    );
  }
  return batch.summary ? (
    <p className="text-xs text-muted-foreground">
      <span title={absoluteTime(batch.finishedAt)}>{relativeTime(batch.finishedAt)}</span> · {batch.summary}
    </p>
  ) : null;
}

function EmptyState({ category, projectPath, onGenerate, busy }: { category: IdeaCategory; projectPath: string; onGenerate: () => void; busy: boolean }) {
  const { label, blurb, icon: Icon } = CATEGORY_INFO[category];
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-border bg-card px-6 py-8 text-center">
        <div className="flex size-11 items-center justify-center rounded-full border border-border bg-background">
          <Icon className="size-5 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-primary">{label}</span>
          <h2 className="text-[15px] font-semibold tracking-tight">No ideas yet</h2>
          <p className="text-[13px] text-muted-foreground">{blurb}</p>
          <p className="text-[13px] text-muted-foreground">
            An agent reads the code in <span className="font-mono text-[12px] break-all">{projectPath}</span> and suggests ideas, each
            with its impact and difficulty. It changes nothing.
          </p>
        </div>
        <Button size="lg" onClick={onGenerate} disabled={busy}>
          {busy ? <Spinner className="size-4" /> : <Sparkles />}
          Generate ideas
        </Button>
      </div>
    </div>
  );
}

// items-start: a card opening its details doesn't stretch the rest of its row.
const grid = 'grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3';

export function IdeasView() {
  const { board, tasks, openTask } = useBoardContext();
  const [params, setParams] = useSearchParams();
  const ideasQ = useIdeas(board.id);
  const generate = useGenerateIdeas(board.id);
  const add = useAddIdea();
  const dismiss = useDismissIdea();

  const storeKey = `ideasCategory:${board.id}`;
  const fromUrl = params.get('category');
  const stored = readString(storeKey);
  const category: IdeaCategory = isIdeaCategory(fromUrl) ? fromUrl : isIdeaCategory(stored) ? stored : 'code_improvements';
  const select = (c: IdeaCategory) => {
    writeString(storeKey, c);
    setParams({ category: c }, { replace: true });
  };

  const batches = ideasQ.data?.batches;
  const ideas = ideasQ.data?.ideas;
  const states = useMemo(() => {
    const out = Object.fromEntries(IDEA_CATEGORIES.map((c) => [c, { latest: undefined, fresh: 0 }])) as Record<IdeaCategory, CategoryState>;
    // Batches come newest first. Marketing tasks share the list; they have their own view.
    for (const b of batches ?? []) if (isIdeaCategory(b.category)) out[b.category].latest ??= b;
    for (const i of ideas ?? []) if (i.status === 'new' && isIdeaCategory(i.category)) out[i.category].fresh++;
    return out;
  }, [batches, ideas]);
  const mine = useMemo(() => (ideas ?? []).filter((i) => i.category === category), [ideas, category]);
  const fresh = mine.filter((i) => i.status === 'new');
  const added = mine.filter((i) => i.status === 'added');

  const { label, icon: Icon } = CATEGORY_INFO[category];
  const latest = states[category].latest;
  const running = isOpen(latest);
  const starting = generate.isPending && generate.variables === category;
  const busy = running || starting;

  const start = () => generate.mutate(category);

  const addIdea = (idea: IdeaView) =>
    add.mutate(idea, {
      onSuccess: ({ task }) =>
        toast.success(`Added to Backlog as #${task.number}`, {
          description: task.title,
          action: { label: 'Open', onClick: () => openTask(task) },
        }),
    });
  const dismissIdea = (idea: IdeaView) =>
    dismiss.mutate(
      { idea, undo: false },
      { onSuccess: () => toast('Idea dismissed', { description: idea.title, action: { label: 'Undo', onClick: () => dismiss.mutate({ idea, undo: true }) } }) },
    );
  const openIdeaTask = (idea: IdeaView) => {
    const task = tasks.find((t) => t.id === idea.taskId);
    if (task) openTask(task);
    else toast('That task is no longer on the board.');
  };

  const card = (idea: IdeaView) => (
    <IdeaCard
      key={idea.id}
      idea={idea}
      adding={add.isPending && add.variables?.id === idea.id}
      onAdd={() => addIdea(idea)}
      onDismiss={() => dismissIdea(idea)}
      onOpenTask={() => openIdeaTask(idea)}
    />
  );

  const showEmpty = !ideasQ.isLoading && mine.length === 0 && !busy && latest?.status !== 'failed' && !(latest?.status === 'done' && latest.ideaCount === 0);

  return (
    <div className="flex h-full min-h-0">
      <CategoryRail states={states} selected={category} onSelect={select} />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-3">
          <CategoryDropdown states={states} selected={category} onSelect={select} />
          <h2 className="hidden min-w-0 items-center gap-2 text-[13px] font-medium md:flex">
            <Icon className="size-4 shrink-0 text-primary" />
            <span className="truncate">{label}</span>
            {fresh.length > 0 && <span className="font-mono text-xs font-normal text-muted-foreground tabular">{fresh.length}</span>}
          </h2>
          <div className="ml-auto flex items-center gap-1.5">
            {!showEmpty && (
              <Tip content={running ? 'Wait for this generation to finish' : 'The agent proposes more ideas, skipping the ones you already have'}>
                <span>
                  <Button size="sm" onClick={start} disabled={busy || ideasQ.isLoading}>
                    {busy ? <Spinner className="size-3.5" /> : <Sparkles />}
                    {busy ? 'Generating…' : mine.length ? 'Generate more' : 'Generate ideas'}
                  </Button>
                </span>
              </Tip>
            )}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {ideasQ.isLoading ? (
            <div className={cn(grid, 'mx-auto max-w-6xl px-3 py-4 sm:px-5')}>
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-40" />
              ))}
            </div>
          ) : showEmpty ? (
            <EmptyState category={category} projectPath={board.projectPath} onGenerate={start} busy={busy} />
          ) : (
            <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-4 sm:px-5">
              <BatchStatus batch={latest} label={label} onRetry={start} retrying={busy} />
              {fresh.length > 0 ? (
                <div className={grid}>{fresh.map(card)}</div>
              ) : (
                running && (
                  <div className={grid} aria-hidden>
                    {Array.from({ length: 3 }, (_, i) => (
                      <Skeleton key={i} className="h-40" />
                    ))}
                  </div>
                )
              )}
              {added.length > 0 && (
                <section className="flex flex-col gap-2.5">
                  <h3 className="flex items-center gap-2 pt-2 text-xs font-medium text-muted-foreground">
                    On the board <span className="font-mono tabular">{added.length}</span>
                  </h3>
                  <div className={grid}>{added.map(card)}</div>
                </section>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
