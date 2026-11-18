import {
  CATEGORIES,
  COMPLEXITIES,
  PRIORITIES,
  type BoardView,
  type Category,
  type Complexity,
  type Priority,
  type TaskView,
} from '@t3-orchestra/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { useMilestones } from '@/api/milestones';
import { useCreateTask } from '@/api/tasks';
import { DepsPicker } from '@/components/DepsPicker';
import { Field } from '@/components/fields';
import { ModelSelect } from '@/components/ModelSelect';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Kbd, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { stageLabel } from '@/lib/stage';
import { splitLines, splitList } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board: BoardView;
  tasks: TaskView[];
}

const opts = <T extends string>(values: readonly T[]) => values.map((v) => ({ value: v, label: v }));

export function NewTaskDialog({ open, onOpenChange, board, tasks }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {open && <NewTaskForm board={board} tasks={tasks} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function NewTaskForm({ board, tasks, onDone }: { board: BoardView; tasks: TaskView[]; onDone: () => void }) {
  const navigate = useNavigate();
  const create = useCreateTask(board.id);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [deps, setDeps] = useState<string[]>([]);
  const [complexity, setComplexity] = useState<Complexity>('medium');
  const [category, setCategory] = useState<Category>('feature');
  const [priority, setPriority] = useState<Priority>('medium');
  const [touches, setTouches] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const milestones = useMilestones(board.id).data ?? [];
  const [milestoneId, setMilestoneId] = useState('none');

  const depOptions = tasks
    .filter((t) => t.stage !== 'discarded')
    .sort((a, b) => a.number - b.number)
    .map((t) => ({ value: t.id, label: `#${t.number}`, title: t.title, meta: stageLabel(t.stage) }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    create.mutate(
      {
        title: title.trim(),
        description,
        acceptanceCriteria: splitLines(criteria),
        dependsOn: deps,
        complexity,
        category,
        priority,
        touches: splitList(touches),
        providerOverride: null,
        modelOverride: model?.trim() || null,
        skipAiReview: false,
        milestoneId: milestones.some((m) => m.id === milestoneId) ? milestoneId : null,
      },
      {
        onSuccess: (task) => {
          toast.success(`Created #${task.number}`, {
            description: task.title,
            action: { label: 'Open', onClick: () => navigate(`/b/${board.slug}/t/${task.number}`) },
          });
          onDone();
        },
        onError: (err) => toast.error('Could not create the task', { description: errorMessage(err) }),
      },
    );
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New task</DialogTitle>
        <DialogDescription>Added to the Backlog of {board.name}.</DialogDescription>
      </DialogHeader>

      <Field label="Title" htmlFor="nt-title">
        <Input
          id="nt-title"
          autoFocus
          required
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Imperative and specific, e.g. Add OAuth callback handler"
        />
      </Field>
      <Field label="Description" hint="Markdown." htmlFor="nt-desc">
        <Textarea
          id="nt-desc"
          rows={5}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What to build and why, key decisions, pointers to relevant files…"
        />
      </Field>
      <Field label="Acceptance criteria" hint="One per line." htmlFor="nt-ac">
        <Textarea
          id="nt-ac"
          rows={3}
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          placeholder={'Callback route exchanges the code for a token\nTests cover the error path'}
        />
      </Field>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Category">
          <Select value={category} onValueChange={setCategory} options={opts(CATEGORIES)} />
        </Field>
        <Field label="Complexity">
          <Select value={complexity} onValueChange={setComplexity} options={opts(COMPLEXITIES)} />
        </Field>
        <Field label="Priority">
          <Select value={priority} onValueChange={setPriority} options={opts(PRIORITIES)} />
        </Field>
      </div>

      <Field label="Depends on" hint="Auto-run starts this task only after these are Done.">
        <DepsPicker options={depOptions} value={deps} onChange={setDeps} />
      </Field>

      {milestones.length > 0 && (
        <Field label="Milestone">
          <Select
            value={milestoneId}
            onValueChange={setMilestoneId}
            options={[{ value: 'none', label: 'No milestone' }, ...milestones.map((m) => ({ value: m.id, label: `M${m.number} · ${m.title}` }))]}
          />
        </Field>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Touches" hint="Paths or areas, comma separated." htmlFor="nt-touches">
          <Input
            id="nt-touches"
            className="font-mono text-xs"
            value={touches}
            onChange={(e) => setTouches(e.target.value)}
            placeholder="src/auth/, src/routes/login.tsx"
          />
        </Field>
        <Field label="Model override" htmlFor="nt-model">
          <ModelSelect
            id="nt-model"
            mode="change"
            provider={board.defaultProvider}
            value={model}
            noneLabel="Board default"
            onChange={setModel}
          />
        </Field>
      </div>

      <DialogFooter className="items-center">
        <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">
          <Kbd>N</Kbd> opens this dialog
        </span>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!title.trim() || create.isPending}>
          {create.isPending && <Spinner className="size-3.5 text-primary-foreground" />}
          Create task
        </Button>
      </DialogFooter>
    </form>
  );
}
