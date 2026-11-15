// Plans: every plan on the board and the tasks it put there. /b/:slug/plans lists them, and
// /b/:slug/plans/:planId opens one to review, refine or accept it.
import type { PlanView } from '@t3-orchestra/shared';
import { ExternalLink, ListTodo, Sparkles } from 'lucide-react';
import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useBoardPlans } from '@/api/plans';
import { useBoardContext } from '@/components/board/BoardContext';
import { Card, Empty } from '@/components/overview/parts';
import { PlanStatusBadge } from '@/components/plan/PlanStatusBadge';
import { Elapsed } from '@/components/tasks/StatusLine';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/input';
import { Skeleton, Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { absoluteTime, relativeTime } from '@/lib/time';
import { pluralize } from '@/lib/utils';
import { needsYou, OPEN_PLAN_STATUSES, plannerBusy, planPath, planTitle, tasksByPlan, type PlanTasks } from './model';
import { LaneBar, PlanTaskList, planProgress, ProgressText } from './PlanTaskList';

const PlanDetail = lazy(() => import('./PlanDetail').then((m) => ({ default: m.PlanDetail })));

/** Open plans that wait on the user first, then failed ones, then those the planner is still on. */
const OPEN_ORDER: Record<string, number> = { needs_input: 0, spec_review: 0, ready: 0, failed: 1, speccing: 2, planning: 2, refining: 2 };

const BUSY_TEXT: Record<string, string> = {
  speccing: 'The planner is working on the spec',
  planning: 'The planner is reading the repo and drafting tasks',
  refining: 'The planner is refining the plan',
};

function PlanCard({ plan, meta, aside, children }: { plan: PlanView; meta: ReactNode; aside?: ReactNode; children?: ReactNode }) {
  const { board } = useBoardContext();
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          to={planPath(board.slug, plan.id)}
          className="group flex min-w-0 flex-1 basis-64 flex-col gap-0.5 rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">P{plan.number}</span>
            <span className="min-w-0 truncate text-[13.5px] font-medium group-hover:underline">{planTitle(plan)}</span>
            {plan.status !== 'accepted' && <PlanStatusBadge status={plan.status} />}
          </span>
          <span className="truncate text-xs text-muted-foreground" title={absoluteTime(plan.createdAt)}>
            {meta}
          </span>
        </Link>
        {aside}
      </header>
      {children}
    </section>
  );
}

function OpenPlanCard({ plan }: { plan: PlanView }) {
  const { board } = useBoardContext();
  const created = `Created ${relativeTime(plan.createdAt)}`;
  if (plannerBusy(plan)) {
    return (
      <PlanCard plan={plan} meta={created}>
        <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Spinner className="size-3.5 text-primary" />
          {BUSY_TEXT[plan.status]}
          {' · '}
          <Elapsed since={plan.updatedAt} />
        </p>
      </PlanCard>
    );
  }
  if (plan.status === 'needs_input') {
    return (
      <PlanCard
        plan={plan}
        meta={`${created} · the planner asked a clarifying question; answer it in T3 and planning goes on`}
        aside={
          plan.threadLink && (
            <Button variant="warning" size="sm" asChild>
              <a href={plan.threadLink} target="_blank" rel="noreferrer">
                <ExternalLink />
                Open in T3
              </a>
            </Button>
          )
        }
      />
    );
  }
  if (plan.status === 'spec_review') {
    return (
      <PlanCard
        plan={plan}
        meta={`${created} · the spec draft and the planner's questions are waiting for you`}
        aside={
          <Button size="sm" asChild>
            <Link to={planPath(board.slug, plan.id)}>Answer questions</Link>
          </Button>
        }
      />
    );
  }
  if (plan.status === 'ready') {
    return (
      <PlanCard
        plan={plan}
        meta={`${created} · proposed tasks are waiting for your review`}
        aside={
          <Button size="sm" asChild>
            <Link to={planPath(board.slug, plan.id)}>Review plan</Link>
          </Button>
        }
      />
    );
  }
  return (
    <PlanCard
      plan={plan}
      meta={created}
      aside={
        <Button variant="secondary" size="sm" asChild>
          <Link to={planPath(board.slug, plan.id)}>Open</Link>
        </Button>
      }
    >
      <p className="line-clamp-2 text-[12.5px] text-destructive">
        {plan.error ?? "The planner's output could not be used."}
      </p>
    </PlanCard>
  );
}

function AcceptedPlanCard({ plan, group, loading }: { plan: PlanView; group: PlanTasks | undefined; loading: boolean }) {
  const counts = group
    ? [pluralize(group.planned.length, 'task'), ...(group.followUps.length ? [pluralize(group.followUps.length, 'follow-up')] : [])]
    : [];
  return (
    <PlanCard
      plan={plan}
      meta={[`Created ${relativeTime(plan.createdAt)}`, ...counts].join(' · ')}
      aside={<ProgressText {...planProgress(group)} />}
    >
      {loading ? (
        <Skeleton className="h-16" />
      ) : group ? (
        <>
          <LaneBar tasks={[...group.planned, ...group.followUps]} />
          <PlanTaskList group={group} limit={5} />
        </>
      ) : (
        <Empty>Its tasks were discarded.</Empty>
      )}
    </PlanCard>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
        {title} <span className="font-mono font-normal">{count}</span>
      </h3>
      {children}
    </section>
  );
}

function PlansIndex({ loading }: { loading: boolean }) {
  const { board, tasks, openPlanComposer } = useBoardContext();
  const plansQ = useBoardPlans(board.id);
  const groups = useMemo(() => tasksByPlan(tasks), [tasks]);
  const { open, accepted } = useMemo(() => {
    const all = plansQ.data ?? [];
    return {
      open: all
        .filter((p) => OPEN_PLAN_STATUSES.has(p.status))
        .sort((a, b) => (OPEN_ORDER[a.status] ?? 3) - (OPEN_ORDER[b.status] ?? 3) || b.number - a.number),
      accepted: all.filter((p) => p.status === 'accepted'),
    };
  }, [plansQ.data]);
  const byHand = groups.get(null);
  const empty = !plansQ.isLoading && open.length === 0 && accepted.length === 0;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 p-3 sm:p-4">
        <header className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 basis-60">
            <h2 className="text-[15px] font-semibold tracking-tight">Plans</h2>
            <p className="text-xs text-muted-foreground">Goals a planner broke into tasks, and where those tasks are now.</p>
          </div>
          <Tip content={<span>New plan <Kbd>P</Kbd></span>}>
            <Button size="sm" onClick={() => openPlanComposer()}>
              <Sparkles />
              New plan
            </Button>
          </Tip>
        </header>

        {plansQ.isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : empty ? (
          <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border px-4 py-12 text-center">
            <div className="flex size-11 items-center justify-center rounded-full border border-border bg-card">
              <ListTodo className="size-5 text-muted-foreground" />
            </div>
            <div className="flex max-w-md flex-col gap-1.5">
              <p className="text-[14px] font-medium">No plans yet</p>
              <p className="text-[13px] text-muted-foreground">
                Describe a goal and a planner thread reads the repo and proposes tasks with dependencies. Nothing reaches the
                board until you accept them.
              </p>
            </div>
            <Button size="sm" onClick={() => openPlanComposer()}>
              <Sparkles />
              New plan
            </Button>
          </div>
        ) : (
          <>
            {open.length > 0 && (
              <Section title="In progress" count={open.length}>
                {open.map((p) => (
                  <OpenPlanCard key={p.id} plan={p} />
                ))}
              </Section>
            )}
            {accepted.length > 0 && (
              <Section title="Accepted" count={accepted.length}>
                {accepted.map((p) => (
                  <AcceptedPlanCard key={p.id} plan={p} group={groups.get(p.id)} loading={loading} />
                ))}
              </Section>
            )}
          </>
        )}

        {!plansQ.isLoading && byHand && (
          <Card title="Not from a plan" subtitle="Tasks added by hand or from Ideas, with their follow-ups">
            <LaneBar tasks={[...byHand.planned, ...byHand.followUps]} />
            <PlanTaskList group={byHand} limit={5} />
          </Card>
        )}
      </div>
    </div>
  );
}

export function PlansView({ planId, loading }: { planId: string | null; loading: boolean }) {
  if (!planId) return <PlansIndex loading={loading} />;
  return (
    <Suspense fallback={null}>
      <PlanDetail planId={planId} loading={loading} />
    </Suspense>
  );
}
