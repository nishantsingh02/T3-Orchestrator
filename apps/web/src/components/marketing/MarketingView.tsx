// Marketing: a dashboard of the project's numbers (connected sources), the brief the agent works
// from, and marketing tasks by category. A read-only agent proposes the tasks, like Ideas: `build`
// ones go on the board, `do` ones come with copy to paste and are ticked off here. The section is in
// the URL (?section=…) and remembered per board.
import { MARKETING_CATEGORIES, PRIORITY_RANK, isMarketingCategory, type IdeaBatchView, type IdeaView, type MarketingCategory } from '@t3-orchestra/shared';
import { ChevronDown, LayoutDashboard, MessageCircleQuestion, Sparkles, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { useAddIdea, useDismissIdea, useGenerateIdeas, useIdeas, useMarkIdeaDone } from '@/api/ideas';
import { useBoardContext } from '@/components/board/BoardContext';
import { BatchStatus, isOpen } from '@/components/ideas/IdeasView';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton, Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { readString, writeString } from '@/lib/storage';
import { cn, pluralize } from '@/lib/utils';
import { BriefCard } from './BriefCard';
import { isMarketingSection, MARKETING_INFO, type MarketingSection } from './categories';
import { KIND_INFO, MarketingCard } from './MarketingCard';
import { MetricsPanel } from './MetricsPanel';

interface CategoryState {
  latest: IdeaBatchView | undefined;
  open: number;
}

const DIFFICULTY_RANK = { easy: 0, medium: 1, hard: 2 } as const;

function CategoryStatus({ state }: { state: CategoryState }) {
  if (isOpen(state.latest)) {
    return state.latest!.status === 'waiting' ? (
      <MessageCircleQuestion className="size-3.5 text-warning" aria-label="Waiting for you in T3" />
    ) : (
      <Spinner className="size-3.5" aria-label="Generating" />
    );
  }
  if (state.latest?.status === 'failed') return <TriangleAlert className="size-3.5 text-destructive" aria-label="Last generation failed" />;
  if (state.open > 0) return <span className="font-mono text-[11px] text-muted-foreground tabular">{state.open}</span>;
  return null;
}

function SectionInfo(section: MarketingSection) {
  return section === 'dashboard' ? { label: 'Dashboard', icon: LayoutDashboard } : MARKETING_INFO[section];
}

function Rail({ states, selected, onSelect }: { states: Record<MarketingCategory, CategoryState>; selected: MarketingSection; onSelect: (s: MarketingSection) => void }) {
  const item = (s: MarketingSection) => {
    const { label, icon: Icon } = SectionInfo(s);
    return (
      <li key={s}>
        <button
          type="button"
          onClick={() => onSelect(s)}
          aria-current={s === selected ? 'page' : undefined}
          className={cn(
            'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
            s === selected ? 'bg-accent font-medium text-foreground' : 'text-foreground/85',
          )}
        >
          <Icon className={cn('size-4 shrink-0', s === selected ? 'text-primary' : 'text-muted-foreground')} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {s !== 'dashboard' && <CategoryStatus state={states[s]} />}
        </button>
      </li>
    );
  };
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface/40 md:flex">
      <nav aria-label="Marketing" className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin">
        <ul className="flex flex-col gap-0.5">{item('dashboard')}</ul>
        <p className="px-2 pt-4 pb-1.5 text-xs font-medium text-muted-foreground">Tasks</p>
        <ul className="flex flex-col gap-0.5">{MARKETING_CATEGORIES.map(item)}</ul>
      </nav>
      <p className="shrink-0 border-t border-border px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
        Generate tasks by category. Build tasks go to the Backlog; Do tasks come with the copy written.
      </p>
    </aside>
  );
}

/** Section picker for narrow screens, where the rail is hidden. */
function SectionDropdown({ states, selected, onSelect }: { states: Record<MarketingCategory, CategoryState>; selected: MarketingSection; onSelect: (s: MarketingSection) => void }) {
  const { label, icon: Icon } = SectionInfo(selected);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-1.5 min-w-0 md:hidden" aria-label={`Section: ${label}`}>
          <Icon className="text-primary" />
          <span className="truncate text-[13px] font-medium">{label}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onSelect={() => onSelect('dashboard')} className={cn(selected === 'dashboard' && 'bg-accent')}>
          <LayoutDashboard />
          Dashboard
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Tasks</DropdownMenuLabel>
        {MARKETING_CATEGORIES.map((c) => {
          const info = MARKETING_INFO[c];
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

/** The best open tasks across categories, and the way in when there are none. */
function UpNext({ tasks, onSelect }: { tasks: IdeaView[]; onSelect: (c: MarketingCategory) => void }) {
  const open = tasks
    .filter((t) => t.status === 'new')
    .sort((a, b) => PRIORITY_RANK[a.impact] - PRIORITY_RANK[b.impact] || DIFFICULTY_RANK[a.difficulty] - DIFFICULTY_RANK[b.difficulty]);
  const done = tasks.filter((t) => t.status === 'done').length;
  const added = tasks.filter((t) => t.status === 'added').length;
  return (
    <section className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3.5" aria-labelledby="marketing-next">
      <div className="flex items-baseline gap-2">
        <h2 id="marketing-next" className="min-w-0 flex-1 text-[13.5px] font-medium">
          Up next
        </h2>
        {tasks.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {open.length} open · {added} on the board · {done} done
          </span>
        )}
      </div>
      {open.length > 0 ? (
        <ul className="-mx-1.5 flex flex-col">
          {open.slice(0, 6).map((t) => {
            const cat = isMarketingCategory(t.category) ? MARKETING_INFO[t.category] : null;
            const kind = KIND_INFO[t.kind];
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => isMarketingCategory(t.category) && onSelect(t.category)}
                  className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-[13px] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  {cat && <cat.icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={cat.label} />}
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <kind.icon className="size-3" />
                    {kind.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px] text-muted-foreground">
            {tasks.length ? 'Everything proposed so far is on the board or done.' : 'No marketing tasks yet.'} Pick a category for the agent to work on:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {MARKETING_CATEGORIES.map((c) => {
              const info = MARKETING_INFO[c];
              return (
                <Button key={c} variant="secondary" size="xs" onClick={() => onSelect(c)}>
                  <info.icon />
                  {info.label}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function EmptyState({ category, projectPath, onGenerate, busy }: { category: MarketingCategory; projectPath: string; onGenerate: () => void; busy: boolean }) {
  const { label, blurb, icon: Icon } = MARKETING_INFO[category];
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-border bg-card px-6 py-8 text-center">
        <div className="flex size-11 items-center justify-center rounded-full border border-border bg-background">
          <Icon className="size-5 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-primary">{label}</span>
          <h2 className="text-[15px] font-semibold tracking-tight">No tasks yet</h2>
          <p className="text-[13px] text-muted-foreground">{blurb}</p>
          <p className="text-[13px] text-muted-foreground">
            An agent reads <span className="font-mono text-[12px] break-all">{projectPath}</span> with your brief and metrics, and suggests
            code changes for the board and things to do, with the copy written. It changes nothing.
          </p>
        </div>
        <Button size="lg" onClick={onGenerate} disabled={busy}>
          {busy ? <Spinner className="size-4" /> : <Sparkles />}
          Generate tasks
        </Button>
      </div>
    </div>
  );
}

const grid = 'grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3';

export function MarketingView() {
  const { board, tasks, openTask } = useBoardContext();
  const [params, setParams] = useSearchParams();
  const ideasQ = useIdeas(board.id);
  const generate = useGenerateIdeas(board.id);
  const add = useAddIdea();
  const dismiss = useDismissIdea();
  const done = useMarkIdeaDone();

  const storeKey = `marketingSection:${board.id}`;
  const fromUrl = params.get('section');
  const stored = readString(storeKey);
  const section: MarketingSection = isMarketingSection(fromUrl) ? fromUrl : isMarketingSection(stored) ? stored : 'dashboard';
  const select = (s: MarketingSection) => {
    writeString(storeKey, s);
    setParams({ section: s }, { replace: true });
  };

  const batches = ideasQ.data?.batches;
  const all = ideasQ.data?.ideas;
  const marketing = useMemo(() => (all ?? []).filter((i) => isMarketingCategory(i.category)), [all]);
  const states = useMemo(() => {
    const out = Object.fromEntries(MARKETING_CATEGORIES.map((c) => [c, { latest: undefined, open: 0 }])) as Record<MarketingCategory, CategoryState>;
    // Batches come newest first.
    for (const b of batches ?? []) if (isMarketingCategory(b.category)) out[b.category].latest ??= b;
    for (const i of marketing) if (i.status === 'new' && isMarketingCategory(i.category)) out[i.category].open++;
    return out;
  }, [batches, marketing]);
  const suggestedBrief = useMemo(() => batches?.find((b) => isMarketingCategory(b.category) && b.suggestedBrief)?.suggestedBrief ?? null, [batches]);

  const category = section === 'dashboard' ? null : section;
  const mine = useMemo(() => marketing.filter((i) => i.category === category), [marketing, category]);
  const fresh = mine.filter((i) => i.status === 'new');
  const added = mine.filter((i) => i.status === 'added');
  const finished = mine.filter((i) => i.status === 'done');
  const latest = category ? states[category].latest : undefined;
  const running = isOpen(latest);
  const starting = generate.isPending && generate.variables === category;
  const busy = running || starting;
  const start = () => category && generate.mutate(category);

  const addTask = (idea: IdeaView) =>
    add.mutate(idea, {
      onSuccess: ({ task }) =>
        toast.success(`Added to Backlog as #${task.number}`, {
          description: task.title,
          action: { label: 'Open', onClick: () => openTask(task) },
        }),
    });
  const dismissTask = (idea: IdeaView) =>
    dismiss.mutate(
      { idea, undo: false },
      { onSuccess: () => toast('Task dismissed', { description: idea.title, action: { label: 'Undo', onClick: () => dismiss.mutate({ idea, undo: true }) } }) },
    );
  const openIdeaTask = (idea: IdeaView) => {
    const task = tasks.find((t) => t.id === idea.taskId);
    if (task) openTask(task);
    else toast('That task is no longer on the board.');
  };

  const card = (idea: IdeaView) => (
    <MarketingCard
      key={idea.id}
      idea={idea}
      busy={(add.isPending && add.variables?.id === idea.id) || (done.isPending && done.variables?.idea.id === idea.id)}
      onAdd={() => addTask(idea)}
      onDone={(undo) => done.mutate({ idea, undo })}
      onDismiss={() => dismissTask(idea)}
      onOpenTask={() => openIdeaTask(idea)}
    />
  );

  const { label, icon: Icon } = SectionInfo(section);
  const showEmpty =
    category !== null && !ideasQ.isLoading && mine.length === 0 && !busy && latest?.status !== 'failed' && !(latest?.status === 'done' && latest.ideaCount === 0);

  return (
    <div className="flex h-full min-h-0">
      <Rail states={states} selected={section} onSelect={select} />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-3">
          <SectionDropdown states={states} selected={section} onSelect={select} />
          <h2 className="hidden min-w-0 items-center gap-2 text-[13px] font-medium md:flex">
            <Icon className="size-4 shrink-0 text-primary" />
            <span className="truncate">{label}</span>
            {category && fresh.length > 0 && <span className="font-mono text-xs font-normal text-muted-foreground tabular">{fresh.length}</span>}
          </h2>
          <div className="ml-auto flex items-center gap-1.5">
            {category && !showEmpty && (
              <Tip content={running ? 'Wait for this generation to finish' : 'The agent proposes more tasks, skipping the ones you already have'}>
                <span>
                  <Button size="sm" onClick={start} disabled={busy || ideasQ.isLoading}>
                    {busy ? <Spinner className="size-3.5" /> : <Sparkles />}
                    {busy ? 'Generating…' : mine.length ? 'Generate more' : 'Generate tasks'}
                  </Button>
                </span>
              </Tip>
            )}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {category === null ? (
            <div className="mx-auto flex max-w-6xl flex-col gap-5 px-3 py-4 sm:px-5">
              {/* Short and fixed in size, so above the metrics, which grow with every source. */}
              <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
                <BriefCard board={board} suggestion={suggestedBrief} />
                {ideasQ.isLoading ? <Skeleton className="h-40" /> : <UpNext tasks={marketing} onSelect={select} />}
              </div>
              <MetricsPanel board={board} />
            </div>
          ) : ideasQ.isLoading ? (
            <div className={cn(grid, 'mx-auto max-w-6xl px-3 py-4 sm:px-5')}>
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-40" />
              ))}
            </div>
          ) : showEmpty ? (
            <EmptyState category={category} projectPath={board.projectPath} onGenerate={start} busy={busy} />
          ) : (
            <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-4 sm:px-5">
              <BatchStatus
                batch={latest}
                label={label}
                onRetry={start}
                retrying={busy}
                noun="tasks"
                working={`The agent is reading the project for ${label.toLowerCase()} tasks…`}
              />
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
              {finished.length > 0 && (
                <section className="flex flex-col gap-2.5">
                  <h3 className="flex items-center gap-2 pt-2 text-xs font-medium text-muted-foreground">
                    Done <span className="font-mono tabular">{finished.length}</span>
                  </h3>
                  <div className={grid}>{finished.map(card)}</div>
                </section>
              )}
              {fresh.length === 0 && !running && added.length + finished.length > 0 && latest?.status === 'done' && latest.ideaCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  All {pluralize(mine.length, 'task')} here are on the board or done. Generate more for new ones.
                </p>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
