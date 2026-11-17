// "New audit": what to read (the whole project, the commits since the last audit, or some paths),
// which areas to focus on, notes for the agent, and the model.
import { SECURITY_AREAS, SECURITY_CATEGORY_INFO, type SecurityArea, type SecurityAuditScope, type SecurityAuditView } from '@t3-orchestra/shared';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '@/api/client';
import { useStartAudit } from '@/api/security';
import { useBoardContext } from '@/components/board/BoardContext';
import { Field } from '@/components/fields';
import { ModelSelect } from '@/components/ModelSelect';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label, Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn, splitLines } from '@/lib/utils';
import { CATEGORY_ICONS, SCOPE_LABELS, shortSha } from './model';

export interface AuditPreset {
  scope?: SecurityAuditScope;
  focus?: SecurityArea[];
  paths?: string[];
  instructions?: string;
}

export function AuditDialog({
  open,
  onOpenChange,
  lastDone,
  commitsSince,
  preset,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The latest finished audit, which a "changes" audit starts from. */
  lastDone: SecurityAuditView | undefined;
  commitsSince: number | null;
  preset?: AuditPreset;
  onStarted: (audit: SecurityAuditView) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {open && <Form lastDone={lastDone} commitsSince={commitsSince} preset={preset} onDone={() => onOpenChange(false)} onStarted={onStarted} />}
      </DialogContent>
    </Dialog>
  );
}

function Form({
  lastDone,
  commitsSince,
  preset,
  onDone,
  onStarted,
}: {
  lastDone: SecurityAuditView | undefined;
  commitsSince: number | null;
  preset?: AuditPreset;
  onDone: () => void;
  onStarted: (audit: SecurityAuditView) => void;
}) {
  const { board } = useBoardContext();
  const start = useStartAudit(board.id);
  const changesBlocked = !lastDone ? 'Needs a finished audit to compare with.' : commitsSince === 0 ? `Nothing committed since audit #${lastDone.number}.` : null;
  const [scope, setScope] = useState<SecurityAuditScope>(preset?.scope && !(preset.scope === 'changes' && changesBlocked) ? preset.scope : 'full');
  const [focus, setFocus] = useState<Set<SecurityArea>>(new Set(preset?.focus ?? []));
  const [paths, setPaths] = useState((preset?.paths ?? []).join('\n'));
  const [instructions, setInstructions] = useState(preset?.instructions ?? '');
  const [model, setModel] = useState<string | null>(null);
  const pathList = splitLines(paths);
  const ready = scope !== 'paths' || pathList.length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || start.isPending) return;
    start.mutate(
      { scope, focus: [...focus], paths: scope === 'paths' ? pathList : [], instructions: instructions.trim(), model },
      {
        onSuccess: (audit) => {
          onStarted(audit);
          onDone();
        },
      },
    );
  };
  const toggle = (a: SecurityArea, on: boolean) =>
    setFocus((prev) => {
      const next = new Set(prev);
      if (on) next.add(a);
      else next.delete(a);
      return next;
    });

  const scopes: Array<{ value: SecurityAuditScope; hint: string; disabled?: string | null }> = [
    { value: 'full', hint: 'Maps the project and goes deep where untrusted input and sensitive data are handled.' },
    {
      value: 'changes',
      hint: lastDone
        ? `The ${commitsSince ?? 'new'} commit${commitsSince === 1 ? '' : 's'} since audit #${lastDone.number} (${shortSha(lastDone.headSha)}), and the code they touch. Quicker.`
        : 'The commits since the last audit, and the code they touch.',
      disabled: changesBlocked,
    },
    { value: 'paths', hint: 'Only the folders or files you list, and what they call.' },
  ];

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>New security audit</DialogTitle>
        <DialogDescription>
          An agent reads <span className="font-mono text-[12px] break-all">{board.projectPath}</span> as an attacker would and reports what it can exploit,
          with evidence. It changes nothing.
        </DialogDescription>
      </DialogHeader>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-xs font-medium">What to audit</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {scopes.map((s) => {
            const selected = scope === s.value;
            return (
              <label
                key={s.value}
                className={cn(
                  'flex cursor-pointer flex-col gap-1 rounded-lg border p-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                  selected ? 'border-primary bg-primary/6' : 'border-border hover:border-border-strong',
                  s.disabled && 'cursor-not-allowed opacity-55 hover:border-border',
                )}
              >
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  <input
                    type="radio"
                    name="scope"
                    value={s.value}
                    checked={selected}
                    disabled={Boolean(s.disabled)}
                    onChange={() => setScope(s.value)}
                    className="size-3.5 accent-[var(--primary)]"
                  />
                  {SCOPE_LABELS[s.value]}
                </span>
                <span className="text-[11.5px] leading-snug text-muted-foreground">{s.disabled ?? s.hint}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {scope === 'paths' && (
        <Field label="Paths" htmlFor="audit-paths" hint="One per line, relative to the project root.">
          <Textarea id="audit-paths" autoFocus rows={3} value={paths} onChange={(e) => setPaths(e.target.value)} placeholder={'src/api/\nsrc/auth/session.ts'} className="font-mono text-xs" />
        </Field>
      )}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 flex w-full items-baseline justify-between gap-2 text-xs font-medium">
          <span>Focus</span>
          <span className="font-normal text-muted-foreground">{focus.size === 0 ? 'Every area' : `${focus.size} of ${SECURITY_AREAS.length} areas`}</span>
        </legend>
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {SECURITY_AREAS.map((a) => {
            const Icon = CATEGORY_ICONS[a];
            const id = `focus-${a}`;
            return (
              <div key={a} className="flex items-start gap-2 rounded-md px-1 py-1 hover:bg-accent/50">
                <Checkbox id={id} checked={focus.has(a)} onCheckedChange={(v) => toggle(a, v === true)} className="mt-0.5" />
                <Label htmlFor={id} className="flex min-w-0 cursor-pointer flex-col gap-0.5 text-[12.5px] font-normal">
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    <Icon className="size-3.5 text-muted-foreground" />
                    {SECURITY_CATEGORY_INFO[a].label}
                  </span>
                  <span className="text-[11.5px] leading-snug text-muted-foreground">{SECURITY_CATEGORY_INFO[a].blurb}</span>
                </Label>
              </div>
            );
          })}
        </div>
      </fieldset>

      <Field label="Notes for the auditor" htmlFor="audit-notes" hint="Optional: what worries you, what changed, what is out of scope.">
        <Textarea id="audit-notes" rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="We open the API to the public next week." />
      </Field>

      <Field label="Model" htmlFor="audit-model">
        <ModelSelect id="audit-model" provider={board.defaultProvider} value={model} onChange={setModel} noneLabel="The board's planner model" mode="change" />
      </Field>

      {start.isError && <p className="rounded-md border border-destructive/35 bg-destructive/8 px-3 py-2 text-[12.5px] text-destructive">{errorMessage(start.error)}</p>}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready || start.isPending}>
          {start.isPending && <Spinner className="size-4" />}
          Start audit
        </Button>
      </DialogFooter>
    </form>
  );
}
