// Spec-first plans: the planner's spec draft and questions, answered here round by round, then
// "Generate tasks". Once tasks exist the spec stays on the plan as a collapsed section.
import type { BoardView, PlanAnswer, PlanDetailView, SpecQuestion, SpecRoundView } from '@t3-orchestra/shared';
import { ArrowRight, ListChecks, Pencil, Sparkles, Trash, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useDiscardPlan, useEditSpec, usePlanFromSpec, useRefineSpec } from '@/api/plans';
import { Markdown } from '@/components/Markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { readJson, writeJson, writeString } from '@/lib/storage';
import { cn, pluralize } from '@/lib/utils';
import { Collapsible, questionText } from './PlanReview';

interface Draft {
  /** The option picked, if any. */
  choice: string | null;
  /** Free text: the whole answer, or details on top of the option. */
  text: string;
}

function answerOf(d: Draft | undefined): string {
  const text = d?.text.trim() ?? '';
  if (d?.choice && text) return `${d.choice}: ${text}`;
  return d?.choice ?? text;
}

/** Answers already sent for the round (it is open again after a failed reply), as drafts. */
function sentDrafts(round: SpecRoundView): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  for (const a of round.answers ?? []) {
    const q = round.questions.find((x) => x.question === a.question);
    out[a.question] = q?.options.includes(a.answer) ? { choice: a.answer, text: '' } : { choice: null, text: a.answer };
  }
  return out;
}

/** Usable rounds, oldest first. */
const usable = (plan: PlanDetailView) => plan.specRounds.filter((r) => !r.validationErrors);

export function SpecPanel({ plan, board }: { plan: PlanDetailView; board: BoardView }) {
  const rounds = usable(plan);
  const current = rounds.at(-1);
  if (!current) return null;
  // The spec is the user's to answer while it waits for them, or after a failed reply before any tasks exist.
  const open = plan.status === 'spec_review' || (plan.status === 'failed' && plan.proposals.length === 0);
  if (open) return <OpenSpec key={current.id} plan={plan} board={board} round={current} earlier={rounds.slice(0, -1)} />;
  return <SpecHistory plan={plan} rounds={rounds} />;
}

/** The spec once it has been sent back (the planner is on it, or tasks were made from it). */
function SpecHistory({ plan, rounds }: { plan: PlanDetailView; rounds: SpecRoundView[] }) {
  const answered = rounds.reduce((n, r) => n + (r.answers?.length ?? 0), 0);
  const hasTasks = plan.proposals.length > 0;
  return (
    // Open while the planner works on it; folded away once there are tasks to review.
    <Collapsible key={hasTasks ? 'tasks' : 'spec'} title="Spec" defaultOpen={!hasTasks}>
      <p className="mb-3 text-xs text-muted-foreground">
        {pluralize(rounds.length, 'round')} with the planner · {pluralize(answered, 'answer')} from you
        {plan.status === 'accepted' && ' · the plan’s tasks get this spec in their prompts'}
      </p>
      <Markdown className="text-[13px]">{plan.spec}</Markdown>
      <RoundHistory rounds={rounds} className="mt-4" />
    </Collapsible>
  );
}

/** What was asked and answered in each round. */
function RoundHistory({ rounds, className }: { rounds: SpecRoundView[]; className?: string }) {
  const sent = rounds.filter((r) => r.answers !== null);
  if (sent.length === 0) return null;
  return (
    <div className={cn('flex flex-col gap-3 border-t border-border pt-3', className)}>
      {sent.map((r) => (
        <div key={r.id} className="flex flex-col gap-1.5">
          <p className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            Round {rounds.indexOf(r) + 1}
            {r.changes && <span className="font-normal tracking-normal normal-case"> · {r.changes}</span>}
          </p>
          {r.questions.length > 0 && (
            <ul className="flex flex-col gap-1 text-[12.5px]">
              {r.questions.map((q, n) => {
                const a = r.answers?.find((x) => x.question === q.question)?.answer;
                return (
                  <li key={n} className="flex flex-col">
                    <span className="text-muted-foreground">{questionText(q.question)}</span>
                    <span className={cn(!a && 'text-muted-foreground/70 italic')}>{a ?? 'Not answered: left to the planner'}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {r.feedback && (
            <p className="text-[12.5px]">
              <span className="text-muted-foreground">Your note: </span>
              {r.feedback}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function OpenSpec({
  plan,
  board,
  round,
  earlier,
}: {
  plan: PlanDetailView;
  board: BoardView;
  round: SpecRoundView;
  earlier: SpecRoundView[];
}) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const refine = useRefineSpec(plan.id);
  const toTasks = usePlanFromSpec(plan.id);
  const edit = useEditSpec(plan.id);
  const discard = useDiscardPlan(plan.id);

  // Answer drafts survive leaving the page, per round, until they are sent.
  const draftsKey = `spec-answers:${plan.id}:${round.id}`;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(
    () => readJson<Record<string, Draft> | null>(draftsKey, null) ?? sentDrafts(round),
  );
  const [note, setNote] = useState('');
  useEffect(() => {
    if (Object.values(drafts).some((d) => answerOf(d))) writeJson(draftsKey, drafts);
    else writeString(draftsKey, null);
  }, [draftsKey, drafts]);

  const [editing, setEditing] = useState<string | null>(null);
  const spec = round.userSpec ?? round.spec;

  const answers: PlanAnswer[] = useMemo(
    () => round.questions.map((q) => ({ question: q.question, answer: answerOf(drafts[q.question]) })).filter((a) => a.answer),
    [round.questions, drafts],
  );
  const unanswered = round.questions.length - answers.length;
  const recommendable = round.questions.filter((q) => q.recommended && !answerOf(drafts[q.question]));

  const setDraft = (question: string, next: Draft) => setDrafts((d) => ({ ...d, [question]: next }));
  const pickRecommended = () =>
    setDrafts((d) => {
      const next = { ...d };
      for (const q of recommendable) {
        const pick = q.recommended!;
        next[q.question] = q.options.includes(pick) ? { choice: pick, text: '' } : { choice: null, text: pick };
      }
      return next;
    });

  const busy = refine.isPending || toTasks.isPending || discard.isPending;
  const blockedByEdit = editing !== null;
  const canSend = (answers.length > 0 || note.trim().length > 0) && !busy && !blockedByEdit;
  const clearDrafts = () => {
    setDrafts({});
    setNote('');
  };

  const send = () => {
    if (!canSend) return;
    refine.mutate({ answers, feedback: note.trim() }, { onSuccess: clearDrafts });
  };

  const generate = async () => {
    if (busy || blockedByEdit) return;
    if (unanswered > 0) {
      const ok = await confirm({
        title: `Generate tasks with ${pluralize(unanswered, 'open question')}?`,
        description:
          unanswered === 1
            ? 'The planner decides it itself and lists what it chose under the plan’s assumptions.'
            : 'The planner decides them itself and lists what it chose under the plan’s assumptions.',
        confirmLabel: 'Generate tasks',
      });
      if (!ok) return;
    }
    toTasks.mutate({ answers, feedback: note.trim() }, { onSuccess: clearDrafts });
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

  const saveEdit = () => {
    if (editing === null) return;
    if (editing.trim() === spec.trim()) return setEditing(null);
    edit.mutate(editing, { onSuccess: () => setEditing(null) });
  };

  const roundNo = earlier.length + 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
        <section className="order-2 flex min-w-0 flex-col rounded-lg border border-border bg-card xl:order-1">
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
            <h3 className="text-[13px] font-semibold">Spec</h3>
            <Badge variant="outline">Round {roundNo}</Badge>
            {round.userSpec !== null && <Badge variant="primary">Edited by you</Badge>}
            <span className="ml-auto flex items-center gap-1">
              {editing === null ? (
                <>
                  {round.userSpec !== null && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => edit.mutate(round.spec)}
                      disabled={edit.isPending}
                      title="Go back to the planner’s version of this round"
                    >
                      <Undo2 />
                      Planner’s version
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" onClick={() => setEditing(spec)}>
                    <Pencil />
                    Edit
                  </Button>
                </>
              ) : (
                <>
                  <Button size="xs" variant="ghost" onClick={() => setEditing(null)} disabled={edit.isPending}>
                    Cancel
                  </Button>
                  <Button size="xs" onClick={saveEdit} disabled={edit.isPending || !editing.trim()}>
                    {edit.isPending && <Spinner className="size-3 text-primary-foreground" />}
                    Save
                  </Button>
                </>
              )}
            </span>
          </header>
          <div className="px-3.5 py-3">
            {round.changes && editing === null && (
              <p className="mb-3 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">What changed: </span>
                {round.changes}
              </p>
            )}
            {editing === null ? (
              <Markdown className="text-[13px]">{spec}</Markdown>
            ) : (
              <>
                <Textarea
                  autoFocus
                  value={editing}
                  onChange={(e) => setEditing(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  rows={24}
                  aria-label="Spec (markdown)"
                  className="min-h-96 font-mono text-[12.5px]"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Markdown. Your version goes to the planner with your next answers or with Generate tasks.
                </p>
              </>
            )}
          </div>
        </section>

        <section className="order-1 flex min-w-0 flex-col rounded-lg border border-stage-needs-input/40 bg-card xl:order-2">
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
            <h3 className="text-[13px] font-semibold">Questions</h3>
            <span className="font-mono text-[11px] text-muted-foreground">{round.questions.length}</span>
            {round.questions.length > 0 && (
              <span className="text-xs text-muted-foreground">· {answers.length} answered</span>
            )}
            {recommendable.length > 0 && (
              <Button size="xs" variant="ghost" className="ml-auto" onClick={pickRecommended}>
                <ListChecks />
                Use recommended
              </Button>
            )}
          </header>
          {round.questions.length === 0 ? (
            <p className="px-3.5 py-3 text-[13px] text-muted-foreground">
              The planner has no more questions. Read the spec, edit it or add a note below if something is off, and
              generate the tasks when it looks right.
            </p>
          ) : (
            <ol className="flex flex-col divide-y divide-border">
              {round.questions.map((q, i) => (
                <QuestionItem
                  key={q.question}
                  n={i + 1}
                  q={q}
                  draft={drafts[q.question] ?? { choice: null, text: '' }}
                  onChange={(d) => setDraft(q.question, d)}
                  onSubmit={send}
                />
              ))}
            </ol>
          )}
        </section>
      </div>

      {earlier.length > 0 && (
        <Collapsible title="Earlier rounds" count={earlier.length} defaultOpen={false}>
          <RoundHistory rounds={earlier} className="border-t-0 pt-0" />
        </Collapsible>
      )}

      <div className="sticky bottom-0 z-10 -mx-4 mt-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="flex min-w-0 flex-1 items-end gap-2">
            <Textarea
              rows={1}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
              }}
              placeholder="Anything else for the planner: a correction, a constraint, something it missed…"
              aria-label="Note to the planner"
              className="min-h-8 flex-1"
            />
            <Button variant="secondary" onClick={send} disabled={!canSend}>
              {refine.isPending ? <Spinner className="size-3.5" /> : <Sparkles />}
              {answers.length > 0 ? `Send ${pluralize(answers.length, 'answer')}` : 'Send note'}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" className="text-destructive" onClick={doDiscard} disabled={busy}>
              <Trash />
              Discard
            </Button>
            <Button onClick={generate} disabled={busy || blockedByEdit}>
              {toTasks.isPending ? <Spinner className="size-3.5 text-primary-foreground" /> : <ArrowRight />}
              Generate tasks
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {blockedByEdit
            ? 'Save or cancel your edit of the spec first.'
            : 'Send answers for another round, as many as you like. Generate tasks sends what you wrote here along with the spec.'}
        </p>
      </div>
    </div>
  );
}

function QuestionItem({
  n,
  q,
  draft,
  onChange,
  onSubmit,
}: {
  n: number;
  q: SpecQuestion;
  draft: Draft;
  onChange: (d: Draft) => void;
  onSubmit: () => void;
}) {
  const hasOptions = q.options.length > 0;
  return (
    <li className="flex gap-2 px-3.5 py-3">
      <span className="w-5 shrink-0 text-right font-mono text-xs leading-5 text-muted-foreground">{n}.</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <p className="text-[13px] font-medium">{questionText(q.question)}</p>
          {q.why && <p className="mt-0.5 text-xs text-muted-foreground">{q.why}</p>}
        </div>
        {hasOptions && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Options for question ${n}`}>
            {q.options.map((o) => {
              const on = draft.choice === o;
              return (
                <button
                  key={o}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange({ ...draft, choice: on ? null : o })}
                  className={cn(
                    'rounded-md border px-2 py-1 text-left text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
                    on
                      ? 'border-primary bg-primary/12 text-foreground'
                      : 'border-border bg-surface text-muted-foreground hover:border-foreground/30 hover:text-foreground',
                  )}
                >
                  {o}
                  {q.recommended === o && <span className={cn('ml-1.5 text-2xs', on ? 'text-primary' : 'text-muted-foreground/80')}>recommended</span>}
                </button>
              );
            })}
          </div>
        )}
        {!hasOptions && q.recommended && (
          <p className="text-xs text-muted-foreground">
            Planner suggests: <span className="text-foreground">{q.recommended}</span>
          </p>
        )}
        <Textarea
          rows={1}
          value={draft.text}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit();
          }}
          placeholder={hasOptions ? (draft.choice ? 'Add details (optional)' : 'Or write your own answer') : 'Your answer'}
          aria-label={`Answer to question ${n}`}
          className="min-h-8"
        />
      </div>
    </li>
  );
}
