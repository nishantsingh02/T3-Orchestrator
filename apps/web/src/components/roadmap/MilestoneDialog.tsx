import type { MilestoneView } from '@t3-orchestra/shared';
import { useState, type FormEvent } from 'react';
import { useCreateMilestone, usePatchMilestone } from '@/api/milestones';
import { useBoardContext } from '@/components/board/BoardContext';
import { Field } from '@/components/fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';

/** Create a milestone (`milestone` null) or edit one. */
export function MilestoneDialog({
  open,
  onOpenChange,
  milestone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  milestone: MilestoneView | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {open && <Form milestone={milestone} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function Form({ milestone, onDone }: { milestone: MilestoneView | null; onDone: () => void }) {
  const { board } = useBoardContext();
  const create = useCreateMilestone(board.id);
  const patch = usePatchMilestone();
  const [title, setTitle] = useState(milestone?.title ?? '');
  const [goal, setGoal] = useState(milestone?.goal ?? '');
  const pending = create.isPending || patch.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || pending) return;
    if (milestone) {
      patch.mutate({ milestone, patch: { title: title.trim(), goal: goal.trim() } }, { onSuccess: onDone });
    } else {
      create.mutate({ title: title.trim(), goal: goal.trim() }, { onSuccess: onDone });
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{milestone ? `Edit M${milestone.number}` : 'New milestone'}</DialogTitle>
        <DialogDescription>A phase of the work that ends in something you can check works.</DialogDescription>
      </DialogHeader>
      <Field label="Title" htmlFor="milestone-title">
        <Input
          id="milestone-title"
          autoFocus
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Users can sign up and log in"
        />
      </Field>
      <Field label="Goal" htmlFor="milestone-goal" hint="What is true once this milestone is done. The planner sees it.">
        <Textarea id="milestone-goal" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
      </Field>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!title.trim() || pending}>
          {milestone ? 'Save' : 'Add milestone'}
        </Button>
      </DialogFooter>
    </form>
  );
}
