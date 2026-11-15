import { computeWaves, findCycle, type BoardView, type PlanDetailView, type PlanTask, type ProposalPatch } from '@t3-orchestra/shared';
import { Check, ChevronDown, ChevronRight, CircleCheck, Plus, Sparkles, Trash, TriangleExclamationPoint } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { useAcceptPlan, useAddProposal, useDeleteProposal, useDiscardPlan, usePatchProposal, useRefinePlan } from '@/api/plans';
import { Markdown } from '@/components/Markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { readJson, writeJson, writeString } from '@/lib/storage';
import { cn, pluralize } from '@/lib/utils';
import { checkProposals, nextKey, withDependencies } from './checks';
import { ProposalTable } from './ProposalTable';

export function Collapsible({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left text-[13px] font-semibold"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
        {title}
        {count !== undefined && <span className="font-mono text-[11px] font-normal text-muted-foreground">{count}</span>}
      </button>
      {open && <div className="border-t border-border px-3.5 py-3">{children}</div>}
    </section>
  );
}

/** Drops numbering the planner may have added ("1. ", "Q2: "); the list numbers the questions itself. */
export function questionText(q: string): string {
  return q.replace(/^\s*(?:Q\s*)?\d+\s*[.):]\s+/i, '');
}

function OpenQuestions({
  questions,
  answers,
  editable,
  sending,
  withNote,
  onAnswer,
  onSend,
}: {
  questions: string[];
  answers: Record<string, string>;
  editable: boolean;
  sending: boolean;
  withNote: boolean;
  onAnswer: (question: string, text: string) => void;
  onSend: () => void;
}) {
  const answered = questions.filter((q) => answers[q]?.trim()).length;
  return (
    <Collapsible title="Open questions" count={questions.length}>
      <ol className="flex flex-col gap-3 text-[13px]">
        {questions.map((q, i) => (
          <li key={i} className="flex gap-2">
            <span className="w-5 shrink-0 text-right font-mono text-xs leading-5 text-muted-foreground">{i + 1}.</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p>{questionText(q)}</p>
              {editable && (
                <Textarea
                  rows={1}
                  value={answers[q] ?? ''}
                  onChange={(e) => onAnswer(q, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSend();
                  }}
                  placeholder="Your answer (optional)"
                  aria-label={`Answer to question ${i + 1}`}
                  className="min-h-8"
                />
              )}
            </div>
          </li>
        ))}
      </ol>
      {editable && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">
            {answered} of {questions.length} answered{withNote ? ' · your Refine note is sent too' : ''}
          </span>
          <Button size="sm" variant="secondary" className="ml-auto" onClick={onSend} disabled={answered === 0 || sending}>
            {sending ? <Spinner className="size-3.5" /> : <Sparkles />}
            Send answers
          </Button>
        </div>
      )}
    </Collapsible>
  );
}

function WavesPanel({ tasks, selected }: { tasks: PlanTask[]; selected: ReadonlySet<string> }) {
  const { waves, cyclic } = useMemo(() => computeWaves(tasks), [tasks]);
  const cycle = useMemo(() => findCycle(tasks), [tasks]);
  const titles = new Map(tasks.map((t) => [t.key, t.title]));
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <h3 className="text-[13px] font-semibold">Waves</h3>
        <span className="text-2xs text-muted-foreground">by dependency depth</span>
      </header>
      <ol className="flex flex-col gap-2 px-3.5 py-3">
        {waves.map((wave, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span className="mt-0.5 w-14 shrink-0 text-xs text-muted-foreground">Wave {i + 1}</span>
            <span className="flex flex-wrap gap-1">
              {wave.map((k) => (
                <span
                  key={k}
                  title={titles.get(k)}
                  className={cn(
                    'rounded border border-border bg-muted px-1.5 py-px font-mono text-[11px]',
                    !selected.has(k) && 'opacity-40 line-through',
                  )}
                >
                  {k}
                </span>
              ))}
            </span>
          </li>
        ))}
        {cyclic.length > 0 && (
          <li className="flex items-start gap-2.5 text-destructive">
            <span className="mt-0.5 w-14 shrink-0 text-xs">Cycle</span>
            <span className="flex flex-col gap-1">
              <span className="flex flex-wrap gap-1">
                {cyclic.map((k) => (
                  <span key={k} className="rounded border border-destructive/40 bg-destructive/10 px-1.5 py-px font-mono text-[11px]">
                    {k}
                  </span>
                ))}
              </span>
              {cycle && <span className="font-mono text-[11px]">{cycle.join(' → ')}</span>}
            </span>
          </li>
        )}
        {waves.length === 0 && cyclic.length === 0 && <li className="text-xs text-muted-foreground">No tasks.</li>}
      </ol>
    </section>
  );
}

export function PlanReview({ plan, board }: { plan: PlanDetailView; board: BoardView }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const patch = usePatchProposal(plan.id);
  const add = useAddProposal(plan.id);
  const del = useDeleteProposal(plan.id);
  const refine = useRefinePlan(plan.id);
  const accept = useAcceptPlan(plan.id);
  const discard = useDiscardPlan(plan.id);

  const tasks = plan.proposals;
  const editable = plan.status === 'ready';
  const version = plan.versions.find((v) => v.version === plan.currentVersion) ?? plan.versions[plan.versions.length - 1];
  const parsed = version?.parsed ?? null;

  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState('');
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // Answer drafts, keyed by question text, survive leaving the page until they are sent.
  const answersKey = `plan-answers:${plan.id}`;
  const [answers, setAnswers] = useState<Record<string, string>>(() => readJson(answersKey, {}));
  useEffect(() => {
    if (Object.keys(answers).length > 0) writeJson(answersKey, answers);
    else writeString(answersKey, null);
  }, [answersKey, answers]);
  const questions = parsed?.openQuestions ?? [];
  const answerList = questions.map((q) => ({ question: q, answer: (answers[q] ?? '').trim() })).filter((a) => a.answer);
  const onAnswer = (question: string, text: string) =>
    setAnswers((a) => {
      const next = { ...a, [question]: text };
      if (!text) delete next[question];
      return next;
    });

  const selected = useMemo(() => new Set(tasks.map((t) => t.key).filter((k) => !deselected.has(k))), [tasks, deselected]);
  const issues = useMemo(() => checkProposals(tasks, plan.options.maxTasks, selected), [tasks, plan.options.maxTasks, selected]);
  const errors = issues.filter((i) => i.level === 'error');
  const errorKeys = useMemo(() => new Set(errors.flatMap((i) => i.keys)), [errors]);
  const selectionGap = issues.some((i) => i.kind === 'selection');
  const changedKeys = useMemo(() => new Set(plan.currentVersion > 1 ? plan.changedKeys : []), [plan.changedKeys, plan.currentVersion]);
  const addedKeys = useMemo(() => new Set(plan.currentVersion > 1 ? plan.addedKeys : []), [plan.addedKeys, plan.currentVersion]);
  const acceptedKeys = useMemo(() => new Set(plan.acceptedKeys), [plan.acceptedKeys]);

  const toggle = (key: string) =>
    setDeselected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleAll = (on: boolean) => setDeselected(on ? new Set() : new Set(tasks.map((t) => t.key)));

  const onPatch = (key: string, p: ProposalPatch) => patch.mutate({ key, patch: p });

  const onDelete = (key: string) => {
    del.mutate(key, {
      onSuccess: (detail) => {
        // Drop the deleted key from anything that depended on it.
        for (const t of detail.proposals) {
          if (t.dependsOn.includes(key)) {
            patch.mutate({ key: t.key, patch: { dependsOn: t.dependsOn.filter((d) => d !== key) } });
          }
        }
      },
    });
  };

  const onAdd = () => {
    const key = nextKey(tasks);
    add.mutate(
      {
        key,
        title: 'New task',
        description: 'Describe what to build and why.',
        acceptanceCriteria: ['Describe how to verify it'],
        complexity: 'small',
        category: 'feature',
        priority: 'medium',
        dependsOn: [],
        touches: [],
      },
      { onSuccess: () => setFocusKey(key) },
    );
  };

  const doAccept = (keys?: string[]) => {
    accept.mutate(keys, {
      onSuccess: ({ tasks: created }) => {
        toast.success(`Accepted ${pluralize(created.length, 'task')}`, {
          description: `Added to ${board.acceptInto === 'ready' ? 'Ready' : 'Backlog'} on ${board.name}.`,
        });
        navigate(`/b/${board.slug}`);
      },
      onError: (err) => toast.error('Could not accept the plan', { description: errorMessage(err) }),
    });
  };

  const doDiscard = async () => {
    const ok = await confirm({
      title: 'Discard this plan?',
      description: 'No tasks are created. The planner thread stays in T3.',
      confirmLabel: 'Discard plan',
      variant: 'destructive',
    });
    if (ok) discard.mutate(undefined, { onSuccess: () => navigate(`/b/${board.slug}/plans`) });
  };

  const canRefine = (feedback.trim().length > 0 || answerList.length > 0) && !refine.isPending;
  const doRefine = () => {
    if (!canRefine) return;
    refine.mutate(
      { feedback: feedback.trim(), answers: answerList },
      {
        onSuccess: () => {
          setFeedback('');
          setAnswers({});
        },
      },
    );
  };

  const allSelected = selected.size === tasks.length;
  const busy = accept.isPending || discard.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-3">
          {parsed?.summary && (
            <Collapsible title="Summary">
              <Markdown className="text-[13px]">{parsed.summary}</Markdown>
            </Collapsible>
          )}
          {(parsed?.milestones?.length ?? 0) > 0 && (
            <Collapsible title="Milestones" count={parsed!.milestones.length}>
              <ol className="space-y-1.5 text-[13px]">
                {parsed!.milestones.map((m, i) => {
                  const n = tasks.filter((t) => t.milestone?.trim().toLowerCase() === m.title.trim().toLowerCase()).length;
                  return (
                    <li key={i}>
                      <span className="font-medium">{m.title}</span>
                      <span className="text-muted-foreground"> · {n} {n === 1 ? 'task' : 'tasks'}</span>
                      {m.goal && <p className="text-xs text-muted-foreground">{m.goal}</p>}
                    </li>
                  );
                })}
              </ol>
              <p className="mt-2 text-xs text-muted-foreground">
                Accepting creates these milestones on the board, or adds to one that already has the same title.
              </p>
            </Collapsible>
          )}
          {parsed && (parsed.assumptions.length > 0 || questions.length > 0) && (
            <div className="grid items-start gap-3 md:grid-cols-2">
              {parsed.assumptions.length > 0 && (
                <Collapsible title="Assumptions" count={parsed.assumptions.length}>
                  <ul className="list-disc space-y-1 pl-4 text-[13px]">
                    {parsed.assumptions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </Collapsible>
              )}
              {questions.length > 0 && (
                <OpenQuestions
                  questions={questions}
                  answers={answers}
                  editable={editable}
                  sending={refine.isPending}
                  withNote={feedback.trim().length > 0}
                  onAnswer={onAnswer}
                  onSend={doRefine}
                />
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <WavesPanel tasks={tasks} selected={editable ? selected : new Set(tasks.map((t) => t.key))} />
          {editable && (
            <section className="rounded-lg border border-border bg-card px-3.5 py-3">
              <h3 className="mb-2 text-[13px] font-semibold">Checks</h3>
              {issues.length === 0 ? (
                <p className="flex items-center gap-1.5 text-xs text-success">
                  <CircleCheck className="size-3.5" />
                  No cycles, unknown dependencies or empty fields.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {issues.map((i, n) => (
                    <li
                      key={n}
                      className={cn('flex items-start gap-1.5 text-xs', i.level === 'error' ? 'text-destructive' : 'text-warning')}
                    >
                      <TriangleExclamationPoint className="mt-px size-3.5 shrink-0" />
                      {i.message}
                    </li>
                  ))}
                </ul>
              )}
              {selectionGap && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="mt-2"
                  onClick={() => {
                    const keep = withDependencies(tasks, selected);
                    setDeselected(new Set(tasks.map((t) => t.key).filter((k) => !keep.has(k))));
                  }}
                >
                  <Check />
                  Select their dependencies too
                </Button>
              )}
            </section>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[14px] font-semibold">Proposed tasks</h2>
        <span className="font-mono text-xs text-muted-foreground">{tasks.length}</span>
        {version && (
          <Badge variant="outline" title={version.source === 'user' ? 'Includes your edits' : 'From the planner'}>
            v{version.version}
            {version.source === 'user' ? ' · edited' : ''}
          </Badge>
        )}
        {plan.currentVersion > 1 && (changedKeys.size > 0 || addedKeys.size > 0) && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            changed since v{plan.currentVersion - 1}:
            {addedKeys.size > 0 && <span className="text-success">{addedKeys.size} new</span>}
            {changedKeys.size > 0 && <span className="text-warning">{changedKeys.size} changed</span>}
          </span>
        )}
        {(patch.isPending || add.isPending || del.isPending) && <Spinner className="size-3.5" />}
        {editable && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onAdd} disabled={add.isPending}>
            <Plus />
            Add task
          </Button>
        )}
      </div>

      <ProposalTable
        tasks={tasks}
        editable={editable}
        selected={selected}
        onToggle={toggle}
        onToggleAll={toggleAll}
        changedKeys={changedKeys}
        addedKeys={addedKeys}
        errorKeys={errorKeys}
        acceptedKeys={plan.status === 'accepted' ? acceptedKeys : undefined}
        onPatch={onPatch}
        onDelete={onDelete}
        focusKey={focusKey}
      />

      {editable && (
        <div className="sticky bottom-0 z-10 -mx-4 mt-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div className="flex min-w-0 flex-1 items-end gap-2">
              <Textarea
                rows={1}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doRefine();
                }}
                placeholder="Ask the planner to refine: split T4, drop the docs task, add tests first…"
                className="min-h-8 flex-1"
              />
              <Button variant="secondary" onClick={doRefine} disabled={!canRefine}>
                {refine.isPending ? <Spinner className="size-3.5" /> : <Sparkles />}
                Refine{answerList.length > 0 && ` + ${pluralize(answerList.length, 'answer')}`}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" className="text-destructive" onClick={doDiscard} disabled={busy}>
                <Trash />
                Discard
              </Button>
              {!allSelected && (
                <Button
                  variant="secondary"
                  disabled={busy || selected.size === 0 || errors.length > 0 || selectionGap}
                  onClick={() => doAccept([...selected])}
                >
                  Accept selected ({selected.size})
                </Button>
              )}
              <Button disabled={busy || tasks.length === 0 || errors.length > 0} onClick={() => doAccept()}>
                {accept.isPending ? <Spinner className="size-3.5 text-primary-foreground" /> : <Check />}
                Accept all ({tasks.length})
              </Button>
            </div>
          </div>
          {errors.length > 0 && (
            <p className="mt-2 text-xs text-destructive">Fix the {pluralize(errors.length, 'problem')} above before accepting.</p>
          )}
        </div>
      )}
    </div>
  );
}
