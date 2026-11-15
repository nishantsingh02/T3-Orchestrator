// One plan inside the Plans view: its status, the proposals to review and, once accepted, its tasks.
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '@/api/client';
import { usePlan } from '@/api/plans';
import { useBoardContext } from '@/components/board/BoardContext';
import { Markdown } from '@/components/Markdown';
import { Card, Empty } from '@/components/overview/parts';
import { PlanReview } from '@/components/plan/PlanReview';
import { PlanStatusBadge } from '@/components/plan/PlanStatusBadge';
import { PlanStatusPanel } from '@/components/plan/PlanStatusPanel';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/spinner';
import { absoluteTime, relativeTime } from '@/lib/time';
import { pluralize } from '@/lib/utils';
import { SpecPanel } from '@/components/plan/SpecPanel';
import { plannerBusy, planTitle, tasksByPlan } from './model';
import { LaneBar, PlanTaskList, planProgress, ProgressText } from './PlanTaskList';

export function PlanDetail({ planId, loading }: { planId: string; loading: boolean }) {
  const { board, tasks } = useBoardContext();
  const planQ = usePlan(planId);
  const plan = planQ.data;
  const [showPrompt, setShowPrompt] = useState(false);
  const group = useMemo(() => tasksByPlan(tasks).get(planId), [tasks, planId]);
  const back = (
    <Link
      to={`/b/${board.slug}/plans`}
      className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      All plans
    </Link>
  );

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      {/* PlanReview's sticky action bar lines up with this padding (-mx-4 sm:-mx-6). */}
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-4 sm:px-6">
        {back}
        {planQ.isError ? (
          <div className="flex flex-col items-start gap-1">
            <p className="text-[14px] font-medium">Could not load the plan</p>
            <p className="text-[13px] text-muted-foreground">{errorMessage(planQ.error)}</p>
          </div>
        ) : !plan ? (
          <>
            <Skeleton className="h-7 w-1/2" />
            <Skeleton className="h-16" />
            <Skeleton className="h-64" />
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[17px] font-semibold tracking-tight">{planTitle(plan)}</h2>
                  <PlanStatusBadge status={plan.status} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground" title={absoluteTime(plan.createdAt)}>
                  Plan {plan.number} · created {relativeTime(plan.createdAt)} · max {plan.options.maxTasks} tasks
                  {plan.options.plannerModel && (
                    <>
                      {' '}
                      · <span className="font-mono">{plan.options.plannerModel}</span>
                    </>
                  )}
                  {plan.options.specFirst ? ' · spec first' : !plan.options.askQuestions && ' · no clarifying questions'}
                </p>
              </div>
              {plan.threadLink && !plannerBusy(plan) && plan.status !== 'needs_input' && (
                <Button variant="ghost" size="sm" asChild>
                  <a href={plan.threadLink} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    Planner thread
                  </a>
                </Button>
              )}
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowPrompt((s) => !s)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {showPrompt ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                Goal prompt
              </button>
              {showPrompt && (
                <div className="mt-2 rounded-lg border border-border bg-card p-4">
                  <Markdown className="text-[13px]">{plan.prompt}</Markdown>
                  {plan.options.extraGuidance && (
                    <>
                      <p className="mt-3 mb-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                        Extra guidance
                      </p>
                      <Markdown className="text-[13px]">{plan.options.extraGuidance}</Markdown>
                    </>
                  )}
                </div>
              )}
            </div>

            <PlanStatusPanel plan={plan} board={board} />
            <SpecPanel plan={plan} board={board} />

            {plan.status === 'accepted' && (
              <Card
                title="Tasks on the board"
                subtitle={`${pluralize(plan.acceptedKeys.length || plan.proposals.length, 'task')} added when the plan was accepted, with the follow-ups they led to`}
                actions={group && <ProgressText {...planProgress(group)} />}
              >
                {loading ? (
                  <Skeleton className="h-24" />
                ) : group ? (
                  <>
                    <LaneBar tasks={[...group.planned, ...group.followUps]} />
                    <PlanTaskList group={group} limit={12} />
                  </>
                ) : (
                  <Empty>None of its tasks are on the board any more (they were discarded).</Empty>
                )}
              </Card>
            )}
            {plan.status === 'discarded' && (
              <div className="rounded-lg border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground">
                This plan was discarded.
              </div>
            )}

            {plan.proposals.length > 0 && <PlanReview key={plan.id} plan={plan} board={board} />}
          </>
        )}
      </div>
    </div>
  );
}
