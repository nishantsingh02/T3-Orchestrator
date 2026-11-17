// One security finding: severity, where, what; expanded, the evidence and how to fix it. Its actions
// follow its status: open → Add to board / dismiss / mark fixed; on the board → its task; fixed or
// dismissed → reopen.
import {
  findingRef,
  SECURITY_DISMISS_LABELS,
  SECURITY_DISMISS_REASONS,
  type SecurityDismissReason,
  type SecurityFindingView,
  type SecuritySeverity,
  type TaskView,
} from '@t3-orchestra/shared';
import { Check, ChevronDown, ChevronUp, Ellipsis, ExternalLink, Plus, RotateCcw, SquareKanban, Undo2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Markdown } from '@/components/Markdown';
import { Field } from '@/components/fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { stageLabel } from '@/lib/stage';
import { absoluteTime, relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { CATEGORY_ICONS, categoryLabel, findingLocation, SEVERITY_STYLE, SOURCE_LABELS } from './model';

export function SeverityBadge({ severity, className }: { severity: SecuritySeverity; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-[5px] border px-1.5 text-2xs leading-none font-semibold whitespace-nowrap',
        SEVERITY_STYLE[severity].badge,
        className,
      )}
    >
      {SEVERITY_STYLE[severity].label}
    </span>
  );
}

function sourceText(f: SecurityFindingView): string {
  return f.source === 'audit' ? (f.auditNumber ? `Audit #${f.auditNumber}` : 'Audit') : SOURCE_LABELS[f.source];
}

function resolvedText(f: SecurityFindingView): string {
  const by = f.resolvedBy === 'audit' ? `audit #${f.resolvedAuditNumber ?? '?'}` : f.resolvedBy === 'scan' ? 'the scan' : 'you';
  return `Fixed · by ${by} · ${relativeTime(f.resolvedAt)}`;
}

export interface FindingActions {
  onAdd: (f: SecurityFindingView) => void;
  onOpenTask: (f: SecurityFindingView) => void;
  onDismiss: (f: SecurityFindingView, reason: SecurityDismissReason, note: string) => void;
  onRestore: (f: SecurityFindingView) => void;
  onFixed: (f: SecurityFindingView, undo: boolean) => void;
  /** The finding whose Add to board is in flight. */
  adding: string | null;
}

export function FindingCard({
  finding: f,
  task,
  expanded,
  onToggle,
  actions,
  hideSource,
}: {
  finding: SecurityFindingView;
  /** In a list of one source only, the source goes without saying. */
  hideSource?: boolean;
  /** Its task, from the board's live task list (fresher than the finding's own copy). */
  task: TaskView | undefined;
  expanded: boolean;
  onToggle: () => void;
  actions: FindingActions;
}) {
  const detailsId = useId();
  const [dismissing, setDismissing] = useState(false);
  const Icon = CATEGORY_ICONS[f.category];
  const where = findingLocation(f);
  const taskStage = task?.stage ?? f.taskStage;
  const taskNumber = task?.number ?? f.taskNumber;
  const taskClosed = !taskStage || taskStage === 'done' || taskStage === 'discarded';
  const quiet = f.status === 'fixed' || f.status === 'dismissed';

  return (
    <article
      id={`finding-${f.number}`}
      className={cn('scroll-mt-4 rounded-lg border border-border bg-card transition-colors hover:border-border-strong', quiet && 'bg-card/60')}
    >
      <div className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-start sm:gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-start gap-2">
            <SeverityBadge severity={f.severity} className={cn('mt-px', quiet && 'opacity-70')} />
            <h3 className="min-w-0 flex-1 text-[13.5px] leading-snug font-medium text-pretty">
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                aria-controls={detailsId}
                className={cn('text-left hover:underline focus-visible:underline focus-visible:outline-none', quiet && 'text-foreground/75')}
              >
                {f.title}
              </button>
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted-foreground">
            <span className="font-mono tabular">{findingRef(f.number)}</span>
            <span className="flex items-center gap-1">
              <Icon className="size-3" />
              {categoryLabel(f.category)}
            </span>
            {where && <span className="max-w-full truncate font-mono text-[11px]" title={where}>{where}</span>}
            {!hideSource && <span>{sourceText(f)}</span>}
            {f.confidence === 'low' && (
              <Tip content="The auditor could not confirm every step; worth a human look">
                <span className="rounded border border-border px-1 leading-4">low confidence</span>
              </Tip>
            )}
          </div>
          <p className={cn('text-[12.5px] leading-relaxed text-muted-foreground', !expanded && 'line-clamp-2')}>{f.description}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1 self-end sm:self-start">
          <StatusAction finding={f} taskNumber={taskNumber} taskStage={taskStage} taskClosed={taskClosed} actions={actions} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`More for ${findingRef(f.number)}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {(f.status === 'open' || f.status === 'added') && (
                <>
                  {f.status === 'added' && taskClosed && (
                    <DropdownMenuItem onSelect={() => actions.onAdd(f)}>
                      <Plus />
                      Add to board again
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => actions.onFixed(f, false)}>
                    <Check />
                    Mark as fixed
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => actions.onDismiss(f, 'false_positive', '')}>Dismiss: false positive</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDismissing(true)}>Dismiss with a reason…</DropdownMenuItem>
                </>
              )}
              {f.status === 'fixed' && (
                <DropdownMenuItem onSelect={() => actions.onFixed(f, true)}>
                  <RotateCcw />
                  Not fixed: reopen
                </DropdownMenuItem>
              )}
              {f.status === 'dismissed' && (
                <DropdownMenuItem onSelect={() => actions.onRestore(f)}>
                  <Undo2 />
                  Restore
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={onToggle}>
                {expanded ? <ChevronUp /> : <ChevronDown />}
                {expanded ? 'Hide details' : 'Show details'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {expanded && <FindingDetails id={detailsId} finding={f} />}

      <DismissDialog finding={f} open={dismissing} onOpenChange={setDismissing} onDismiss={(reason, note) => actions.onDismiss(f, reason, note)} />
    </article>
  );
}

function StatusAction({
  finding: f,
  taskNumber,
  taskStage,
  taskClosed,
  actions,
}: {
  finding: SecurityFindingView;
  taskNumber: number | null;
  taskStage: TaskView['stage'] | null;
  taskClosed: boolean;
  actions: FindingActions;
}) {
  if (f.status === 'open') {
    const adding = actions.adding === f.id;
    return (
      <Button variant="secondary" size="sm" onClick={() => actions.onAdd(f)} disabled={adding}>
        {adding ? <Spinner className="size-3.5" /> : <Plus />}
        Add to board
      </Button>
    );
  }
  if (f.status === 'added') {
    return (
      <Tip content={taskStage === 'done' ? 'Done. The next audit or scan confirms the fix.' : 'Open the task'}>
        <Button variant="ghost" size="sm" onClick={() => actions.onOpenTask(f)} disabled={taskNumber === null}>
          <SquareKanban />
          {taskNumber === null ? 'On the board' : `#${taskNumber}`}
          {taskStage && <span className={cn('font-normal', taskClosed ? 'text-muted-foreground' : 'text-primary')}>· {stageLabel(taskStage)}</span>}
        </Button>
      </Tip>
    );
  }
  if (f.status === 'fixed') {
    return (
      <span className="flex h-7 items-center gap-1.5 px-1 text-xs text-success" title={absoluteTime(f.resolvedAt)}>
        <Check className="size-3.5" />
        {resolvedText(f)}
      </span>
    );
  }
  return (
    <Tip content={f.dismissNote || 'No note'}>
      <span className="flex h-7 items-center px-1 text-xs text-muted-foreground">{f.dismissReason ? SECURITY_DISMISS_LABELS[f.dismissReason] : 'Dismissed'}</span>
    </Tip>
  );
}

function FindingDetails({ id, finding: f }: { id: string; finding: SecurityFindingView }) {
  const cweNumber = f.cwe ? /\d+/.exec(f.cwe)?.[0] : null;
  return (
    <div id={id} className="flex flex-col gap-3 border-t border-border px-3.5 py-3 text-[12.5px]">
      {f.details.trim() && <Markdown className="text-[12.5px]">{f.details}</Markdown>}
      {f.recommendation.trim() && (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">How to fix</h4>
          <Markdown className="text-[12.5px]">{f.recommendation}</Markdown>
        </section>
      )}
      {f.acceptanceCriteria.length > 0 && (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Fixed when</h4>
          <ul className="list-disc space-y-0.5 pl-4">
            {f.acceptanceCriteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </section>
      )}
      {f.status === 'dismissed' && f.dismissNote && (
        <p className="rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-xs">
          <span className="font-medium">{f.dismissReason ? SECURITY_DISMISS_LABELS[f.dismissReason] : 'Dismissed'}:</span> {f.dismissNote}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
        {cweNumber && (
          <a className="flex items-center gap-1 hover:text-foreground" href={`https://cwe.mitre.org/data/definitions/${cweNumber}.html`} target="_blank" rel="noreferrer">
            {f.cwe}
            <ExternalLink className="size-3" />
          </a>
        )}
        <span>Confidence: {f.confidence}</span>
        <span title={absoluteTime(f.firstSeenAt)}>First seen {relativeTime(f.firstSeenAt)}</span>
        {f.lastSeenAt !== f.firstSeenAt && <span title={absoluteTime(f.lastSeenAt)}>last seen {relativeTime(f.lastSeenAt)}</span>}
      </div>
    </div>
  );
}

const REASON_HINTS: Record<SecurityDismissReason, string> = {
  false_positive: 'It is not a real problem here.',
  accepted_risk: 'It is real, and you accept it. Say why: audits read the note.',
  wont_fix: 'It is real, but not worth fixing now.',
};

function DismissDialog({
  finding,
  open,
  onOpenChange,
  onDismiss,
}: {
  finding: SecurityFindingView;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDismiss: (reason: SecurityDismissReason, note: string) => void;
}) {
  const [reason, setReason] = useState<SecurityDismissReason>('accepted_risk');
  const [note, setNote] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onDismiss(reason, note.trim());
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Dismiss {findingRef(finding.number)}</DialogTitle>
            <DialogDescription className="line-clamp-2">{finding.title}</DialogDescription>
          </DialogHeader>
          <Field label="Reason" hint={REASON_HINTS[reason]}>
            <Select value={reason} onValueChange={setReason} options={SECURITY_DISMISS_REASONS.map((r) => ({ value: r, label: SECURITY_DISMISS_LABELS[r] }))} aria-label="Reason" />
          </Field>
          <Field label="Note" hint="Optional. Shown in the report and to later audits.">
            <Textarea rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="Only reachable from the admin VPN." />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Dismiss</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
