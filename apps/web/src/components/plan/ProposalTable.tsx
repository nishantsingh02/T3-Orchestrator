import {
  CATEGORIES,
  COMPLEXITIES,
  PRIORITIES,
  wouldCreateCycle,
  type PlanTask,
  type ProposalPatch,
} from '@t3-orchestra/shared';
import { ChevronDown, ChevronRight, Trash } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { DepsPicker } from '@/components/DepsPicker';
import { CommitInput } from '@/components/fields';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tip } from '@/components/ui/tooltip';
import { cn, sameArray, splitLines, splitList } from '@/lib/utils';

const opts = <T extends string>(values: readonly T[]) => values.map((v) => ({ value: v, label: v }));

/** Textarea that commits on blur. */
function CommitTextarea({
  value,
  onCommit,
  rows,
  placeholder,
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  rows: number;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return (
    <Textarea
      rows={rows}
      value={draft}
      placeholder={placeholder}
      className={className}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        if (draft !== value) onCommit(draft);
      }}
    />
  );
}

interface Props {
  tasks: PlanTask[];
  editable: boolean;
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onToggleAll: (on: boolean) => void;
  changedKeys: ReadonlySet<string>;
  addedKeys: ReadonlySet<string>;
  /** Keys with a live-check error. */
  errorKeys: ReadonlySet<string>;
  acceptedKeys?: ReadonlySet<string>;
  onPatch: (key: string, patch: ProposalPatch) => void;
  onDelete: (key: string) => void;
  /** Key of a row to expand and focus (e.g. a freshly added one). */
  focusKey?: string | null;
}

export function ProposalTable({
  tasks,
  editable,
  selected,
  onToggle,
  onToggleAll,
  changedKeys,
  addedKeys,
  errorKeys,
  acceptedKeys,
  onPatch,
  onDelete,
  focusKey,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (focusKey) setExpanded((s) => new Set(s).add(focusKey));
  }, [focusKey]);

  const allOn = tasks.length > 0 && tasks.every((t) => selected.has(t.key));
  const someOn = tasks.some((t) => selected.has(t.key));
  const toggleExpand = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="overflow-x-auto rounded-lg border border-border scrollbar-thin">
      <table className="w-full min-w-[1140px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border bg-surface text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            <th className="w-9 px-2.5 py-2">
              {editable && (
                <Checkbox
                  checked={allOn ? true : someOn ? 'indeterminate' : false}
                  onCheckedChange={(v) => onToggleAll(v === true)}
                  aria-label="Select all"
                />
              )}
            </th>
            <th className="w-7 py-2" />
            <th className="w-12 py-2">Key</th>
            <th className="py-2 pr-2">Title</th>
            <th className="w-40 py-2 pr-2">Milestone</th>
            <th className="w-28 py-2 pr-2">Category</th>
            <th className="w-24 py-2 pr-2">Complexity</th>
            <th className="w-24 py-2 pr-2">Priority</th>
            <th className="w-48 py-2 pr-2">Depends on</th>
            <th className="w-52 py-2 pr-2">Touches</th>
            <th className="w-9 py-2" />
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const isOpen = expanded.has(t.key);
            const changed = changedKeys.has(t.key);
            const added = addedKeys.has(t.key);
            const hasError = errorKeys.has(t.key);
            const accepted = acceptedKeys?.has(t.key);
            const depOptions = tasks
              .filter((o) => o.key !== t.key)
              .map((o) => {
                const cycle = wouldCreateCycle(tasks, t.key, o.key);
                return {
                  value: o.key,
                  label: o.key,
                  title: o.title,
                  disabled: cycle,
                  disabledReason: cycle ? 'would create a cycle' : undefined,
                };
              });
            const unknown = new Set(t.dependsOn.filter((d) => !tasks.some((o) => o.key === d)));
            return (
              <Fragment key={t.key}>
                <tr
                  className={cn(
                    'border-b border-border align-middle transition-colors',
                    isOpen ? 'bg-accent/30' : 'hover:bg-accent/20',
                    editable && !selected.has(t.key) && 'text-muted-foreground',
                  )}
                >
                  <td
                    className={cn(
                      'border-l-2 border-l-transparent px-2.5 py-1.5',
                      added && 'border-l-success',
                      changed && !added && 'border-l-warning',
                      hasError && 'border-l-destructive',
                    )}
                  >
                    {editable ? (
                      <Checkbox checked={selected.has(t.key)} onCheckedChange={() => onToggle(t.key)} aria-label={`Select ${t.key}`} />
                    ) : accepted ? (
                      <span className="text-success">✓</span>
                    ) : null}
                  </td>
                  <td className="py-1.5">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => toggleExpand(t.key)}
                      aria-label={isOpen ? 'Collapse' : 'Expand'}
                      aria-expanded={isOpen}
                    >
                      {isOpen ? <ChevronDown /> : <ChevronRight />}
                    </Button>
                  </td>
                  <td className="py-1.5 font-mono text-xs">
                    <span className="flex flex-col leading-tight">
                      {t.key}
                      {added && <span className="text-[9.5px] font-sans font-medium text-success uppercase">new</span>}
                      {changed && !added && (
                        <span className="text-[9.5px] font-sans font-medium text-warning uppercase">changed</span>
                      )}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2">
                    {editable ? (
                      <CommitInput
                        value={t.title}
                        aria-label={`${t.key} title`}
                        className={cn('h-7 border-transparent bg-transparent shadow-none hover:border-input dark:bg-transparent', t.title.trim().length < 3 && 'border-destructive')}
                        onCommit={(title) => onPatch(t.key, { title: title ?? '' })}
                      />
                    ) : (
                      <button type="button" className="text-left font-medium" onClick={() => toggleExpand(t.key)}>
                        {t.title}
                      </button>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    {editable ? (
                      <CommitInput
                        value={t.milestone ?? ''}
                        aria-label={`${t.key} milestone`}
                        placeholder="—"
                        className="h-7 border-transparent bg-transparent text-xs shadow-none hover:border-input dark:bg-transparent"
                        onCommit={(v) => {
                          const milestone = v?.trim() || null;
                          if (milestone !== (t.milestone?.trim() || null)) onPatch(t.key, { milestone });
                        }}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">{t.milestone || '—'}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    {editable ? (
                      <Select size="sm" value={t.category} onValueChange={(category) => onPatch(t.key, { category })} options={opts(CATEGORIES)} />
                    ) : (
                      t.category
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    {editable ? (
                      <Select size="sm" value={t.complexity} onValueChange={(complexity) => onPatch(t.key, { complexity })} options={opts(COMPLEXITIES)} />
                    ) : (
                      t.complexity
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    {editable ? (
                      <Select size="sm" value={t.priority} onValueChange={(priority) => onPatch(t.key, { priority })} options={opts(PRIORITIES)} />
                    ) : (
                      <span className={t.priority === 'high' ? 'text-warning' : undefined}>{t.priority}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    {editable ? (
                      <DepsPicker
                        size="sm"
                        options={depOptions}
                        value={t.dependsOn}
                        danger={unknown}
                        placeholder="none"
                        onChange={(dependsOn) => !sameArray(dependsOn, t.dependsOn) && onPatch(t.key, { dependsOn })}
                      />
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground">{t.dependsOn.join(' ') || '—'}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    {editable ? (
                      <CommitInput
                        mono
                        value={t.touches.join(', ')}
                        aria-label={`${t.key} touches`}
                        placeholder="—"
                        className="h-7 border-transparent bg-transparent shadow-none hover:border-input dark:bg-transparent"
                        onCommit={(v) => {
                          const touches = splitList(v ?? '');
                          if (!sameArray(touches, t.touches)) onPatch(t.key, { touches });
                        }}
                      />
                    ) : (
                      <span className="font-mono text-[11px] text-muted-foreground">{t.touches.join(', ') || '—'}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-1.5">
                    {editable && (
                      <Tip content={`Delete ${t.key}`}>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => onDelete(t.key)}
                          aria-label={`Delete ${t.key}`}
                        >
                          <Trash />
                        </Button>
                      </Tip>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-border bg-accent/15">
                    <td />
                    <td />
                    <td colSpan={9} className="py-3 pr-4">
                      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
                        <div>
                          <p className="mb-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Description</p>
                          {editable ? (
                            <CommitTextarea
                              rows={7}
                              value={t.description}
                              className="text-[12.5px]"
                              onCommit={(description) => onPatch(t.key, { description })}
                            />
                          ) : (
                            <Markdown className="text-[13px]">{t.description}</Markdown>
                          )}
                        </div>
                        <div>
                          <p className="mb-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                            Acceptance criteria {editable && <span className="normal-case">(one per line)</span>}
                          </p>
                          {editable ? (
                            <CommitTextarea
                              rows={7}
                              value={t.acceptanceCriteria.join('\n')}
                              className="text-[12.5px]"
                              onCommit={(v) => {
                                const acceptanceCriteria = splitLines(v);
                                if (!sameArray(acceptanceCriteria, t.acceptanceCriteria)) onPatch(t.key, { acceptanceCriteria });
                              }}
                            />
                          ) : (
                            <ul className="list-disc space-y-0.5 pl-4 text-[13px]">
                              {t.acceptanceCriteria.map((c, i) => (
                                <li key={i}>{c}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
