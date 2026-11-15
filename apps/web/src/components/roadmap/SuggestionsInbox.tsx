import type { SuggestionRef, SuggestionView } from '@t3-orchestra/shared';
import { Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useAddSuggestions, useDismissSuggestions } from '@/api/milestones';
import { milestoneKey, useBoardContext } from '@/components/board/BoardContext';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { stageLabel } from '@/lib/stage';
import { readString, writeString } from '@/lib/storage';
import { plural } from '@/components/overview/parts';

const NONE = '__none';
const keyOf = (s: SuggestionRef) => `${s.taskId}\n${s.text}`;
const ref = (s: SuggestionView): SuggestionRef => ({ taskId: s.taskId, text: s.text });

/** Agent follow-up suggestions from every task, to add (into a milestone) or dismiss, one at a time or in bulk. */
export function SuggestionsInbox({ suggestions, loading }: { suggestions: SuggestionView[] | undefined; loading: boolean }) {
  const { board, tasks, milestones, openTask } = useBoardContext();
  const add = useAddSuggestions(board.id);
  const dismiss = useDismissSuggestions(board.id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const targetKey = `suggestionTarget:${board.id}`;
  const [target, setTarget] = useState<string>(() => readString(targetKey) ?? NONE);
  const milestoneId = milestones.some((m) => m.id === target) ? target : null;

  const list = useMemo(() => suggestions ?? [], [suggestions]);
  const groups = useMemo(() => {
    const out = new Map<string, SuggestionView[]>();
    for (const s of list) out.set(s.taskId, [...(out.get(s.taskId) ?? []), s]);
    return [...out.values()];
  }, [list]);
  // Selection only keeps suggestions that are still in the list.
  const chosen = list.filter((s) => selected.has(keyOf(s)));
  const allOn = list.length > 0 && chosen.length === list.length;

  const toggle = (s: SuggestionView) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(keyOf(s))) next.delete(keyOf(s));
      else next.add(keyOf(s));
      return next;
    });

  const doAdd = (items: SuggestionView[]) => {
    const m = milestones.find((x) => x.id === milestoneId);
    add.mutate(
      { items: items.map(ref), milestoneId },
      {
        onSuccess: (created) => {
          setSelected((prev) => new Set([...prev].filter((k) => !items.some((s) => keyOf(s) === k))));
          toast.success(`Added ${plural(created.length, 'task')}${m ? ` to ${milestoneKey(m)}` : ''}`, {
            description: `They're in ${board.acceptInto === 'ready' ? 'Ready' : 'Backlog'}.`,
          });
        },
      },
    );
  };
  const doDismiss = (items: SuggestionView[]) => {
    const refs = items.map(ref);
    dismiss.mutate(
      { items: refs, undo: false },
      {
        onSuccess: () => {
          setSelected((prev) => new Set([...prev].filter((k) => !refs.some((s) => keyOf(s) === k))));
          toast(`Dismissed ${plural(refs.length, 'suggestion')}`, {
            action: { label: 'Undo', onClick: () => dismiss.mutate({ items: refs, undo: true }) },
          });
        },
      },
    );
  };

  const options = [
    { value: NONE, label: 'No milestone' },
    ...milestones.map((m) => ({ value: m.id, label: `${milestoneKey(m)} · ${m.title}` })),
  ];
  const busy = add.isPending || dismiss.isPending;

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-11rem)]">
      <header>
        <h2 className="flex items-baseline gap-2 text-[13px] font-semibold tracking-tight">
          Suggestions
          {list.length > 0 && <span className="text-xs font-normal text-muted-foreground tabular">{list.length}</span>}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Follow-ups the agents suggested that you haven't added or dismissed.</p>
      </header>

      {loading ? (
        <Skeleton className="h-40" />
      ) : list.length === 0 ? (
        <p className="py-2 text-[12.5px] text-muted-foreground">Nothing waiting. New suggestions show up here as agents finish tasks.</p>
      ) : (
        <>
          <div className="flex flex-col gap-2 border-b border-border pb-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="shrink-0">Add to</span>
              <Select
                size="sm"
                className="min-w-0 flex-1"
                value={milestoneId ?? NONE}
                onValueChange={(v) => {
                  setTarget(v);
                  writeString(targetKey, v);
                }}
                options={options}
                aria-label="Milestone for added suggestions"
              />
            </label>
            <div className="flex items-center gap-2">
              <Checkbox
                checked={allOn ? true : chosen.length > 0 ? 'indeterminate' : false}
                onCheckedChange={() => setSelected(allOn ? new Set() : new Set(list.map(keyOf)))}
                aria-label="Select all suggestions"
              />
              <span className="flex-1 text-xs text-muted-foreground">{chosen.length ? `${chosen.length} selected` : 'Select all'}</span>
              <Button size="xs" variant="ghost" disabled={!chosen.length || busy} onClick={() => doDismiss(chosen)}>
                <X />
                Dismiss
              </Button>
              <Button size="xs" disabled={!chosen.length || busy} onClick={() => doAdd(chosen)}>
                <Plus />
                Add{chosen.length > 1 ? ` ${chosen.length}` : ''}
              </Button>
            </div>
          </div>

          <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1 scrollbar-thin">
            {groups.map((g) => {
              const first = g[0]!;
              const source = tasks.find((t) => t.id === first.taskId);
              return (
                <div key={first.taskId} className="flex flex-col gap-1">
                  <SourceLine suggestion={first} onOpen={source ? () => openTask(source, 'review') : undefined} />
                  <ul className="flex flex-col">
                    {g.map((s) => (
                      <li key={keyOf(s)} className="group flex items-start gap-2 rounded-md px-1 py-1 hover:bg-accent/60">
                        <Checkbox
                          className="mt-0.5"
                          checked={selected.has(keyOf(s))}
                          onCheckedChange={() => toggle(s)}
                          aria-label="Select suggestion"
                        />
                        <button
                          type="button"
                          onClick={() => toggle(s)}
                          className="min-w-0 flex-1 text-left text-[12.5px] leading-snug"
                          title={s.text}
                        >
                          <span className="line-clamp-3">{s.text}</span>
                        </button>
                        <span className="flex shrink-0 items-center opacity-70 group-hover:opacity-100">
                          <Tip content="Add as a task">
                            <Button variant="ghost" size="icon-xs" disabled={busy} onClick={() => doAdd([s])} aria-label="Add as a task">
                              <Plus />
                            </Button>
                          </Tip>
                          <Tip content="Dismiss">
                            <Button variant="ghost" size="icon-xs" disabled={busy} onClick={() => doDismiss([s])} aria-label="Dismiss">
                              <X />
                            </Button>
                          </Tip>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function SourceLine({ suggestion: s, onOpen }: { suggestion: SuggestionView; onOpen?: () => void }) {
  const { milestones } = useBoardContext();
  const m = milestones.find((x) => x.id === s.milestoneId);
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className="flex min-w-0 items-baseline gap-1.5 text-left text-[11.5px] text-muted-foreground hover:text-foreground"
    >
      <span className="shrink-0 font-mono">#{s.taskNumber}</span>
      <span className="min-w-0 truncate">{s.taskTitle}</span>
      <span className="shrink-0">· {stageLabel(s.taskStage)}</span>
      {m && <span className="shrink-0 font-mono">· {milestoneKey(m)}</span>}
    </button>
  );
}
