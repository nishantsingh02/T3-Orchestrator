import type { BoardView, PlanDetailView } from '@t3-orchestra/shared';
import { ExternalLink, RefreshCw, Trash, TriangleExclamationPoint } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useDiscardPlan, useRetryPlan } from '@/api/plans';
import { Elapsed } from '@/components/tasks/StatusLine';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Spinner } from '@/components/ui/spinner';

function latestRunStart(plan: PlanDetailView): string {
  const runs = [...plan.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return runs[0]?.startedAt ?? plan.updatedAt ?? plan.createdAt;
}

function ThreadLink({ href }: { href: string | null }) {
  if (!href) return null;
  return (
    <Button variant="ghost" size="sm" asChild>
      <a href={href} target="_blank" rel="noreferrer">
        <ExternalLink />
        Planner thread
      </a>
    </Button>
  );
}

/** Planning / refining / needs input / failed states of a plan (spec §14.4). */
export function PlanStatusPanel({ plan, board }: { plan: PlanDetailView; board: BoardView }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const retry = useRetryPlan(plan.id);
  const discard = useDiscardPlan(plan.id);

  if (plan.status === 'speccing' || plan.status === 'planning' || plan.status === 'refining') {
    const hasSpec = plan.specRounds.some((r) => !r.validationErrors);
    const [title, doing] =
      plan.status === 'speccing'
        ? hasSpec
          ? ['Updating the spec…', 'The planner is working your answers into the spec and checking what else it needs to ask.']
          : ['Drafting the spec…', 'The planner is reading the repo, writing a first spec and the questions it has for you.']
        : plan.status === 'planning'
          ? ['Planning…', hasSpec ? 'The planner is splitting the spec into tasks.' : 'The planner is reading the repo and drafting tasks.']
          : ['Refining the plan…', 'The planner is reworking the tasks.'];
    return (
      <div className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3.5">
        <div className="relative grid size-9 place-content-center rounded-full bg-primary/10">
          <Spinner className="size-4.5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">
            {doing} <Elapsed since={latestRunStart(plan)} /> elapsed. You can leave this page; you'll get a notification
            when it's ready.
          </p>
        </div>
        <ThreadLink href={plan.threadLink} />
      </div>
    );
  }

  if (plan.status === 'needs_input') {
    return (
      <div className="flex items-center gap-4 rounded-lg border border-stage-needs-input/40 bg-stage-needs-input/10 px-4 py-3.5">
        <span className="text-xl leading-none">❓</span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium">The planner is waiting for you in T3.</p>
          <p className="text-xs text-muted-foreground">
            It asked a clarifying question. Answer it in T3 and planning continues on its own ·{' '}
            <Elapsed since={latestRunStart(plan)} />
          </p>
        </div>
        {plan.threadLink && (
          <Button variant="warning" asChild>
            <a href={plan.threadLink} target="_blank" rel="noreferrer">
              <ExternalLink />
              Open in T3
            </a>
          </Button>
        )}
      </div>
    );
  }

  if (plan.status === 'failed') {
    // The newest reply that could not be used: a plan version or a spec round.
    const latest = [...plan.versions, ...plan.specRounds.map((r) => ({ ...r, version: r.round, label: `round ${r.round}` }))]
      .filter((v) => v.rawText || v.validationErrors)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const latestLabel = latest && 'label' in latest ? latest.label : `v${latest?.version}`;
    const doDiscard = async () => {
      const ok = await confirm({
        title: 'Discard this plan?',
        confirmLabel: 'Discard plan',
        variant: 'destructive',
      });
      if (ok) discard.mutate(undefined, { onSuccess: () => navigate(`/b/${board.slug}/plans`) });
    };
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-destructive/35 bg-destructive/6 p-4">
        <div className="flex items-start gap-3">
          <TriangleExclamationPoint className="mt-0.5 size-4.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-destructive">The planner's output could not be used</p>
            {plan.specRounds.some((r) => !r.validationErrors) && plan.proposals.length === 0 && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                The spec below is kept: answer or Generate tasks again, or Retry in a fresh planner thread.
              </p>
            )}
            <p className="mt-0.5 text-[13px] whitespace-pre-wrap text-muted-foreground">
              {plan.error ?? 'The result block was missing or invalid, even after one correction.'}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <ThreadLink href={plan.threadLink} />
            <Button variant="ghost" className="text-destructive" onClick={doDiscard} disabled={discard.isPending}>
              <Trash />
              Discard
            </Button>
            <Button onClick={() => retry.mutate()} disabled={retry.isPending}>
              {retry.isPending ? <Spinner className="size-3.5 text-primary-foreground" /> : <RefreshCw />}
              Retry
            </Button>
          </div>
        </div>
        {latest?.validationErrors && latest.validationErrors.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Validation errors ({latestLabel})</p>
            <ul className="list-disc space-y-0.5 pl-5 font-mono text-[11.5px] text-destructive">
              {latest.validationErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        {latest?.rawText && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Raw planner output</p>
            <pre className="max-h-[50vh] overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap scrollbar-thin">
              {latest.rawText}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return null;
}
