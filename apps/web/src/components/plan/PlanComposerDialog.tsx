import { MAX_PLAN_TASKS, type BoardView } from '@t3-orchestra/shared';
import { Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { useCreatePlan } from '@/api/plans';
import { Field, NumberInput, SwitchRow } from '@/components/fields';
import { ModelSelect } from '@/components/ModelSelect';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Kbd, Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { readJson, readString, writeJson, writeString } from '@/lib/storage';

interface Draft {
  prompt: string;
  plannerModel: string;
  maxTasks: number;
  askQuestions: boolean;
  extraGuidance: string;
}

const EMPTY: Draft = { prompt: '', plannerModel: '', maxTasks: 20, askQuestions: true, extraGuidance: '' };
const draftKey = (boardId: string) => `planDraft:${boardId}`;
/** Spec first sticks across plans (the draft is cleared when a plan starts). */
const SPEC_FIRST_KEY = 'planSpecFirst';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board: BoardView;
  /** Replaces the saved draft's prompt (e.g. "Plan next milestone" on the Roadmap). */
  initialPrompt?: string;
}

export function PlanComposerDialog({ open, onOpenChange, board, initialPrompt }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        {open && <Composer board={board} initialPrompt={initialPrompt} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function Composer({ board, initialPrompt, onDone }: { board: BoardView; initialPrompt?: string; onDone: () => void }) {
  const navigate = useNavigate();
  const create = useCreatePlan(board.id);
  const [draft, setDraft] = useState<Draft>(() => ({
    ...EMPTY,
    ...readJson<Partial<Draft>>(draftKey(board.id), {}),
    ...(initialPrompt ? { prompt: initialPrompt } : {}),
  }));
  const [specFirst, setSpecFirstState] = useState(() => readString(SPEC_FIRST_KEY) === '1');
  const setSpecFirst = (v: boolean) => {
    setSpecFirstState(v);
    writeString(SPEC_FIRST_KEY, v ? '1' : null);
  };
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const first = useRef(true);

  // Autosave the draft per board (debounced).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => {
      writeJson(draftKey(board.id), draft);
      setSavedAt(Date.now());
    }, 400);
    return () => clearTimeout(t);
  }, [draft, board.id]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft.prompt.trim() || create.isPending) return;
    create.mutate(
      {
        prompt: draft.prompt.trim(),
        options: {
          plannerModel: draft.plannerModel.trim() || null,
          maxTasks: draft.maxTasks,
          askQuestions: draft.askQuestions,
          extraGuidance: draft.extraGuidance,
          specFirst,
        },
      },
      {
        onSuccess: (plan) => {
          writeString(draftKey(board.id), null);
          onDone();
          navigate(`/b/${board.slug}/plans/${plan.id}`);
        },
        onError: (err) => toast.error('Could not start the planner', { description: errorMessage(err) }),
      },
    );
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          New plan
        </DialogTitle>
        <DialogDescription>
          {specFirst
            ? 'Describe the goal. A planner thread reads the repo, drafts a spec and asks you what it needs to know. Tasks come once you are happy with the spec.'
            : 'Describe the goal. A planner thread reads the repo and proposes tasks with dependencies for you to review.'}
        </DialogDescription>
      </DialogHeader>

      <Textarea
        autoFocus
        value={draft.prompt}
        onChange={(e) => set('prompt', e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={14}
        className="min-h-64 font-mono text-[12.5px]"
        placeholder={'# Goal\n\nWhat you want built, why, and any constraints. Markdown is fine.'}
      />

      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Field label="Planner model" htmlFor="pc-model">
          <ModelSelect
            id="pc-model"
            mode="change"
            provider={board.defaultProvider}
            value={draft.plannerModel || null}
            noneLabel="Board default"
            onChange={(v) => set('plannerModel', v ?? '')}
          />
        </Field>
        <Field label="Max tasks" hint={`Up to ${MAX_PLAN_TASKS}.`} htmlFor="pc-max">
          <NumberInput
            id="pc-max"
            mode="change"
            value={draft.maxTasks}
            min={1}
            max={MAX_PLAN_TASKS}
            onCommit={(v) => set('maxTasks', v)}
          />
        </Field>
        <div className="sm:col-span-2">
          <SwitchRow
            label="Refine a spec first"
            hint="The planner drafts a spec and asks you questions here. You answer, it updates the spec, as many rounds as you like, then Generate tasks."
            checked={specFirst}
            onCheckedChange={setSpecFirst}
          />
          {!specFirst && (
            <SwitchRow
              label="Ask clarifying questions before planning"
              hint="The planner may pause for your answers in T3 (the plan shows Needs input)."
              checked={draft.askQuestions}
              onCheckedChange={(v) => set('askQuestions', v)}
            />
          )}
        </div>
        <Field label="Extra planner guidance" className="sm:col-span-2" htmlFor="pc-guidance">
          <Textarea
            id="pc-guidance"
            rows={2}
            value={draft.extraGuidance}
            onChange={(e) => set('extraGuidance', e.target.value)}
            placeholder="Optional, e.g. keep tasks small; prefer tests first"
          />
        </Field>
      </div>

      <DialogFooter className="items-center">
        <span className="mr-auto hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
          {savedAt ? 'Draft saved' : 'Drafts autosave'} · <Kbd>Ctrl</Kbd>
          <Kbd>Enter</Kbd> to {specFirst ? 'start' : 'generate'}
        </span>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
        <Button type="submit" disabled={!draft.prompt.trim() || create.isPending}>
          {create.isPending ? <Spinner className="size-3.5 text-primary-foreground" /> : <Sparkles />}
          {specFirst ? 'Draft spec' : 'Generate plan'}
        </Button>
      </DialogFooter>
    </form>
  );
}
