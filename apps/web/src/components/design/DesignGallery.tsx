import type { DesignOptionView, DesignRoundView, TaskView } from '@t3-orchestra/shared';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Hammer,
  Maximize,
  Monitor,
  Palette,
  Shuffle,
  Smartphone,
  Tablet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { useTaskDetail } from '@/api/tasks';
import { useBoardContext, type DesignOptionRef } from '@/components/board/BoardContext';
import { useActionPending } from '@/components/tasks/useTaskActions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input, Kbd, Label, Textarea } from '@/components/ui/input';
import { Skeleton, Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { isTypingTarget } from '@/lib/hotkeys';
import { readJson, readString, writeJson, writeString } from '@/lib/storage';
import { cn } from '@/lib/utils';
import {
  draftKey,
  EMPTY_DRAFT,
  findOption,
  openRound,
  optionKey,
  optionLabel,
  pickedIn,
  roundBadge,
  type Draft,
} from './model';
import { ScaledFrame } from './ScaledFrame';

type Viewport = 'fit' | 'desktop' | 'tablet' | 'phone';
const VIEWPORTS: Array<{ id: Viewport; label: string; width: number | null; icon: LucideIcon }> = [
  { id: 'fit', label: 'Fit to window', width: null, icon: Maximize },
  { id: 'desktop', label: 'Desktop (1280 px)', width: 1280, icon: Monitor },
  { id: 'tablet', label: 'Tablet (820 px)', width: 820, icon: Tablet },
  { id: 'phone', label: 'Phone (390 px)', width: 390, icon: Smartphone },
];
const VIEWPORT_KEY = 'designViewport';

interface Props {
  task: TaskView;
  at?: DesignOptionRef;
  onClose: () => void;
}

/**
 * Every round of a task's HTML design options, near full screen: browse them at device widths, tick
 * the ones to use (from any round), say what to take from each, then build or ask for another round.
 */
export function DesignGallery({ task, at, onClose }: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const detail = useTaskDetail(task.id);
  const rounds = useMemo(() => detail.data?.designRounds ?? [], [detail.data]);
  const open = openRound(task, rounds);
  const newestFirst = useMemo(() => [...rounds].reverse(), [rounds]);
  const all = useMemo(() => newestFirst.flatMap((r) => r.options), [newestFirst]);

  const [viewing, setViewing] = useState<string | null>(at ? optionKey(at) : null);
  const current = all.find((o) => optionKey(o) === viewing) ?? open?.options[0] ?? all[0];
  const index = current ? all.indexOf(current) : -1;
  const step = (d: number) => {
    if (all.length > 0) setViewing(optionKey(all[(index + d + all.length) % all.length]!));
  };

  const [viewport, setViewport] = useState<Viewport>(() => (readString(VIEWPORT_KEY) as Viewport | null) ?? 'fit');
  useEffect(() => writeString(VIEWPORT_KEY, viewport), [viewport]);

  // The draft survives closing the gallery, per open round.
  const key = open ? draftKey(task.id, open.round) : null;
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  useEffect(() => {
    const stored = key ? readJson<Partial<Draft> | null>(key, null) : null;
    setDraft({ picks: Array.isArray(stored?.picks) ? stored.picks : [], notes: typeof stored?.notes === 'string' ? stored.notes : '' });
  }, [key]);
  const updateDraft = (next: Draft) => {
    setDraft(next);
    if (key) writeJson(key, next);
  };
  const picks = draft.picks.filter((p) => findOption(rounds, p));
  const isPicked = (o: DesignOptionView) => picks.some((p) => optionKey(p) === optionKey(o));
  const togglePick = (o: DesignOptionView) => {
    if (!open) return;
    updateDraft({
      ...draft,
      picks: isPicked(o) ? picks.filter((p) => optionKey(p) !== optionKey(o)) : [...picks, { round: o.round, file: o.file, note: '' }],
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') step(1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(-1);
    else if (e.key.toLowerCase() === 'x' && current) togglePick(current);
    else return;
    e.preventDefault();
  };

  const width = VIEWPORTS.find((v) => v.id === viewport)!.width;
  const question = open?.question ?? rounds.at(-1)?.question ?? null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        showClose={false}
        aria-describedby={undefined}
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(e) => {
          // Focus the gallery (so the arrow keys work at once) rather than its first button.
          e.preventDefault();
          contentRef.current?.focus();
        }}
        className="flex h-[calc(100dvh-1.5rem)] max-h-none w-[calc(100vw-1.5rem)] max-w-none flex-col gap-0 overflow-hidden p-0"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
          <Palette className="size-4 shrink-0 text-stage-human-review" />
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex min-w-0 items-baseline gap-2 text-[14px]">
              <span className="font-mono text-[12.5px] font-normal text-muted-foreground tabular">#{task.number}</span>
              <span className="truncate">{task.title}</span>
            </DialogTitle>
            <p className="truncate text-xs text-muted-foreground">{question ?? 'Design options'}</p>
          </div>
          <div className="hidden items-center rounded-md border border-border p-0.5 sm:flex" role="group" aria-label="Preview width">
            {VIEWPORTS.map((v) => (
              <Tip key={v.id} content={v.label}>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={v.label}
                  aria-pressed={viewport === v.id}
                  onClick={() => setViewport(v.id)}
                  className={cn(viewport === v.id && 'bg-accent text-foreground')}
                >
                  <v.icon />
                </Button>
              </Tip>
            ))}
          </div>
          {current && (
            <Tip content="Open this option in a new tab">
              <Button size="icon-sm" variant="ghost" asChild>
                <a href={current.url} target="_blank" rel="noreferrer" aria-label="Open in a new tab">
                  <ExternalLink />
                </a>
              </Button>
            </Tip>
          )}
          <Tip content={<span>Close <Kbd>Esc</Kbd></span>}>
            <DialogClose asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Close">
                <X />
              </Button>
            </DialogClose>
          </Tip>
        </header>

        {detail.isLoading ? (
          <div className="grid flex-1 gap-3 p-4 lg:grid-cols-[264px_1fr]">
            <Skeleton className="h-64" />
            <Skeleton className="h-full min-h-64" />
          </div>
        ) : all.length === 0 || !current ? (
          <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted-foreground">
            No design options for #{task.number}.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-thin lg:grid lg:grid-cols-[264px_minmax(0,1fr)_312px] lg:grid-rows-1 lg:overflow-hidden">
            <section className="order-first flex min-h-[70dvh] flex-col lg:order-none lg:col-start-2 lg:row-start-1 lg:min-h-0">
              <PreviewBar
                option={current}
                position={`${index + 1} / ${all.length}`}
                canPick={open !== null}
                picked={isPicked(current)}
                onPick={() => togglePick(current)}
                onStep={step}
              />
              <div className="relative min-h-0 flex-1 bg-muted/40 p-3">
                <ScaledFrame
                  key={current.url}
                  src={current.url}
                  title={optionLabel(current)}
                  width={width}
                  className="h-full w-full rounded-md"
                />
              </div>
            </section>

            <nav
              aria-label="Design options"
              className="border-t border-border lg:col-start-1 lg:row-start-1 lg:overflow-y-auto lg:border-t-0 lg:border-r lg:scrollbar-thin"
            >
              {newestFirst.map((r) => (
                <RoundList
                  key={r.id}
                  round={r}
                  rounds={rounds}
                  open={open}
                  current={current}
                  isPicked={isPicked}
                  onView={(o) => setViewing(optionKey(o))}
                  onPick={togglePick}
                />
              ))}
            </nav>

            <aside className="border-t border-border lg:col-start-3 lg:row-start-1 lg:overflow-y-auto lg:border-t-0 lg:border-l lg:scrollbar-thin">
              {open ? (
                <ChoicePanel
                  task={task}
                  rounds={rounds}
                  draft={{ ...draft, picks }}
                  onChange={updateDraft}
                  onView={(o) => setViewing(optionKey(o))}
                  onDone={() => {
                    if (key) writeString(key, null);
                    onClose();
                  }}
                />
              ) : (
                <DecidedPanel task={task} rounds={rounds} />
              )}
            </aside>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBar({
  option,
  position,
  canPick,
  picked,
  onPick,
  onStep,
}: {
  option: DesignOptionView;
  position: string;
  canPick: boolean;
  picked: boolean;
  onPick: () => void;
  onStep: (d: number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <div className="flex items-center">
        <Tip content={<span>Previous <Kbd>←</Kbd></span>}>
          <Button size="icon-xs" variant="ghost" onClick={() => onStep(-1)} aria-label="Previous option">
            <ChevronLeft />
          </Button>
        </Tip>
        <span className="w-10 text-center font-mono text-[11px] text-muted-foreground tabular">{position}</span>
        <Tip content={<span>Next <Kbd>→</Kbd></span>}>
          <Button size="icon-xs" variant="ghost" onClick={() => onStep(1)} aria-label="Next option">
            <ChevronRight />
          </Button>
        </Tip>
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
          <span className="font-semibold">{optionLabel(option)}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">round {option.round}</span>
        </p>
        {option.summary && (
          <p className="truncate text-[11.5px] text-muted-foreground" title={option.summary}>
            {option.summary}
          </p>
        )}
      </div>
      {canPick && (
        <Tip content={<span>{picked ? 'Remove from your choice' : 'Add to your choice'} <Kbd>X</Kbd></span>}>
          <Button size="sm" variant={picked ? 'default' : 'secondary'} onClick={onPick} aria-pressed={picked}>
            <Check />
            {picked ? 'Picked' : 'Use this'}
          </Button>
        </Tip>
      )}
    </div>
  );
}

function RoundList({
  round,
  rounds,
  open,
  current,
  isPicked,
  onView,
  onPick,
}: {
  round: DesignRoundView;
  rounds: readonly DesignRoundView[];
  open: DesignRoundView | null;
  current: DesignOptionView;
  isPicked: (o: DesignOptionView) => boolean;
  onView: (o: DesignOptionView) => void;
  onPick: (o: DesignOptionView) => void;
}) {
  const badge = roundBadge(round, open);
  return (
    <section className="border-b border-border py-2 last:border-b-0">
      <header className="flex items-center gap-2 px-3 py-1">
        <h3 className="text-xs font-semibold">Round {round.round}</h3>
        <Badge variant={badge.variant} size="sm">
          {badge.label}
        </Badge>
      </header>
      {round.summary && <p className="line-clamp-2 px-3 pb-1 text-[11.5px] text-muted-foreground">{round.summary}</p>}
      <ul>
        {round.options.map((o) => {
          const active = optionKey(o) === optionKey(current);
          const earlier = pickedIn(rounds, o);
          return (
            <li key={o.file} className={cn('flex items-start gap-2 px-2 transition-colors', active ? 'bg-accent' : 'hover:bg-accent/50')}>
              <button
                type="button"
                onClick={() => onView(o)}
                aria-current={active ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-1 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span
                  className={cn(
                    'mt-px grid size-5 shrink-0 place-content-center rounded-[5px] font-mono text-[11px] font-semibold',
                    active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {o.letter}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-5 font-medium">{o.title}</span>
                  {o.summary && <span className="line-clamp-2 text-[11.5px] leading-4 text-muted-foreground">{o.summary}</span>}
                  {earlier.length > 0 && (
                    <span className="mt-0.5 block text-[10.5px] text-success">
                      Used in your round {earlier.join(', ')} choice
                    </span>
                  )}
                </span>
              </button>
              {open && (
                <Checkbox
                  checked={isPicked(o)}
                  onCheckedChange={() => onPick(o)}
                  aria-label={`Use option ${o.letter} of round ${o.round}`}
                  className="mt-2.5 mr-1"
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ChoicePanel({
  task,
  rounds,
  draft,
  onChange,
  onView,
  onDone,
}: {
  task: TaskView;
  rounds: readonly DesignRoundView[];
  draft: Draft;
  onChange: (d: Draft) => void;
  onView: (o: DesignOptionView) => void;
  onDone: () => void;
}) {
  const { run } = useBoardContext();
  const pending = useActionPending(task.id, 'choose-design');
  const [sending, setSending] = useState<'build' | 'more' | null>(null);
  const ready = draft.picks.length > 0 || draft.notes.trim().length > 0;
  const several = draft.picks.length > 1;

  const submit = async (mode: 'build' | 'more') => {
    setSending(mode);
    const design = { mode, picks: draft.picks.map((p) => ({ ...p, note: p.note.trim() })), notes: draft.notes.trim() };
    const updated = await run(task, 'choose-design', { design });
    setSending(null);
    if (!updated) return;
    toast.success(mode === 'build' ? `#${task.number}: building your design` : `#${task.number}: making new options`);
    onDone();
  };

  return (
    <div className="flex min-h-full flex-col gap-4 p-4">
      <div>
        <h3 className="text-[13px] font-semibold">Your choice</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Tick the options you want: one, or several to combine. Older rounds count too.
        </p>
      </div>

      {draft.picks.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          Nothing picked yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {draft.picks.map((p, i) => {
            const o = findOption(rounds, p)!;
            const setNote = (note: string) => onChange({ ...draft, picks: draft.picks.map((x, j) => (j === i ? { ...x, note } : x)) });
            return (
              <li key={optionKey(p)} className="rounded-md border border-border bg-surface p-2.5">
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => onView(o)} className="min-w-0 flex-1 truncate text-left text-[13px] font-medium hover:underline">
                    {optionLabel(o)}
                  </button>
                  <span className="shrink-0 text-[10.5px] text-muted-foreground">round {p.round}</span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${optionLabel(o)}`}
                    onClick={() => onChange({ ...draft, picks: draft.picks.filter((_, j) => j !== i) })}
                  >
                    <X />
                  </Button>
                </div>
                <Input
                  value={p.note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={4000}
                  placeholder={several ? 'What to take from it, e.g. the layout' : 'Anything to change? (optional)'}
                  aria-label={`Note for ${optionLabel(o)}`}
                  className="mt-2 h-7 text-xs"
                />
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="design-notes">Notes for the agent</Label>
        <Textarea
          id="design-notes"
          rows={4}
          maxLength={20_000}
          value={draft.notes}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
          placeholder={several ? "e.g. B's layout with A's colours; keep the header sticky" : 'e.g. Make the header sticky'}
        />
      </div>

      <div className="mt-auto flex flex-col gap-2 pt-2">
        <Button disabled={!ready || pending} onClick={() => void submit('build')}>
          {sending === 'build' ? <Spinner className="size-4 text-current" /> : <Hammer />}
          {several ? 'Build this combination' : 'Build with this'}
        </Button>
        <Button variant="secondary" disabled={!ready || pending} onClick={() => void submit('more')}>
          {sending === 'more' ? <Spinner className="size-4 text-current" /> : <Shuffle />}
          Show me new options
        </Button>
        <p className="text-[11px] leading-4 text-muted-foreground">
          <span className="font-medium text-foreground/80">Build:</span> the agent builds it in the app, then AI review and your
          review as usual. <span className="font-medium text-foreground/80">New options:</span> another round in the direction of
          your picks and notes.
        </p>
      </div>
    </div>
  );
}

/** Not waiting for a pick: what the agent does with the last choice, and every decision so far. */
function DecidedPanel({ task, rounds }: { task: TaskView; rounds: readonly DesignRoundView[] }) {
  const decided = rounds.filter((r) => r.choice).reverse();
  const run = task.activeRun;
  const working =
    run?.kind === 'design' ? 'The agent is building your design.' : run?.kind === 'options' ? `The agent is making round ${run.round ?? ''}.` : null;
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="flex items-center gap-2 text-[13px]">
        {working ? (
          <>
            <Spinner className="size-3.5" />
            {working}
          </>
        ) : (
          <span className="text-muted-foreground">#{task.number} isn't waiting for a design pick.</span>
        )}
      </p>
      {decided.map((r) => (
        <section key={r.id} className="flex flex-col gap-1.5 rounded-md border border-border bg-surface p-2.5 text-xs">
          <p className="font-medium">
            Round {r.round}: {r.status === 'chosen' ? 'you chose to build' : 'you asked for more'}
          </p>
          {r.choice!.picks.map((p) => {
            const o = findOption(rounds, p);
            return (
              <p key={optionKey(p)} className="text-muted-foreground">
                <span className="text-foreground/85">{o ? optionLabel(o) : p.file}</span> (round {p.round})
                {p.note && `: ${p.note}`}
              </p>
            );
          })}
          {r.choice!.notes && <p className="whitespace-pre-wrap text-muted-foreground">{r.choice!.notes}</p>}
        </section>
      ))}
    </div>
  );
}
