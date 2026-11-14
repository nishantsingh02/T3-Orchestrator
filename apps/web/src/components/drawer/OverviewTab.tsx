import {
  CATEGORIES,
  COMPLEXITIES,
  PRIORITIES,
  wouldCreateCycle,
  type BoardView,
  type PatchTaskBody,
  type TaskDetailView,
  type TaskView,
} from '@t3-orchestra/shared';
import { CircleCheck, ExternalLink, GitPullRequest, Pencil, Unlink } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useBoardPlans } from '@/api/plans';
import { useT3Models } from '@/api/settings';
import { usePatchTask } from '@/api/tasks';
import { useOptionalBoardContext } from '@/components/board/BoardContext';
import { planPath, planTitle } from '@/components/plans/model';
import { DepsPicker } from '@/components/DepsPicker';
import { CommitInput } from '@/components/fields';
import { Markdown } from '@/components/Markdown';
import { ModelSelect, modelsOf, ProviderSelect } from '@/components/ModelSelect';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { absoluteTime, relativeTime } from '@/lib/time';
import { cn, splitLines, splitList } from '@/lib/utils';
import { stageLabel } from '@/lib/stage';

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex h-6 items-center justify-between gap-2">
      <h3 className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{children}</h3>
      {action}
    </div>
  );
}

/** Markdown/text block with an Edit → Save/Cancel cycle. */
function EditableBlock({
  value,
  editable,
  onSave,
  render,
  placeholder,
  rows = 8,
  mono,
}: {
  value: string;
  editable: boolean;
  onSave: (v: string) => void;
  render: (v: string) => ReactNode;
  placeholder: string;
  rows?: number;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          autoFocus
          rows={rows}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className={mono ? 'font-mono text-[12px]' : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              onSave(draft);
              setDraft(null);
            }
          }}
        />
        <div className="flex justify-end gap-1.5">
          <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <Button
            size="xs"
            onClick={() => {
              if (draft !== value) onSave(draft);
              setDraft(null);
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="group relative">
      {value.trim() ? render(value) : <p className="text-[13px] text-muted-foreground/70 italic">{placeholder}</p>}
      {editable && (
        <Button
          size="icon-xs"
          variant="ghost"
          className="absolute -top-1 right-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => setDraft(value)}
          aria-label="Edit"
        >
          <Pencil />
        </Button>
      )}
    </div>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="py-1 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 py-1 text-[13px]">{children}</dd>
    </>
  );
}

const opts = <T extends string>(values: readonly T[]) => values.map((v) => ({ value: v, label: v }));

export function OverviewTab({ task, board, tasks }: { task: TaskDetailView | TaskView; board: BoardView; tasks: TaskView[] }) {
  const patch = usePatchTask();
  const editable = task.stage === 'backlog' || task.stage === 'ready';
  const milestones = useOptionalBoardContext()?.milestones ?? [];
  const plan = useBoardPlans(board.id).data?.find((p) => p.id === task.planId);
  const save = (p: PatchTaskBody) => patch.mutate({ task, patch: p });
  const catalog = useT3Models().data;

  const graph = useMemo(() => tasks.map((t) => ({ key: t.id, dependsOn: t.deps.map((d) => d.id) })), [tasks]);
  const depOptions = useMemo(
    () =>
      tasks
        .filter((t) => t.id !== task.id && t.stage !== 'discarded')
        .sort((a, b) => a.number - b.number)
        .map((t) => {
          const cycle = wouldCreateCycle(graph, task.id, t.id);
          return {
            value: t.id,
            label: `#${t.number}`,
            title: t.title,
            meta: stageLabel(t.stage),
            disabled: cycle,
            disabledReason: cycle ? 'would create a cycle' : undefined,
          };
        }),
    [tasks, task.id, graph],
  );
  const depIds = task.deps.map((d) => d.id);
  const blocked = new Set(task.blockedBy.map((d) => d.id));

  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionTitle>Description</SectionTitle>
        <EditableBlock
          value={task.description}
          editable={editable}
          onSave={(description) => save({ description })}
          render={(v) => <Markdown>{v}</Markdown>}
          placeholder="No description."
          rows={10}
        />
      </section>

      <section>
        <SectionTitle>Acceptance criteria</SectionTitle>
        <EditableBlock
          value={task.acceptanceCriteria.join('\n')}
          editable={editable}
          onSave={(v) => save({ acceptanceCriteria: splitLines(v) })}
          render={() => (
            <ul className="flex flex-col gap-1.5">
              {task.acceptanceCriteria.map((c, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-snug">
                  <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          )}
          placeholder="No acceptance criteria. One per line."
          rows={5}
        />
      </section>

      <section>
        <SectionTitle>Dependencies</SectionTitle>
        {editable ? (
          <DepsPicker
            options={depOptions}
            value={depIds}
            danger={blocked}
            onChange={(dependsOn) => save({ dependsOn })}
            placeholder="Add dependency"
          />
        ) : task.deps.length === 0 ? (
          <p className="text-[13px] text-muted-foreground/70 italic">None.</p>
        ) : null}
        {!editable && task.deps.length > 0 && (
          <ul className="flex flex-col gap-1">
            {task.deps.map((d) => {
              const isBlocked = blocked.has(d.id);
              return (
                <li key={d.id} className="flex items-center gap-2 text-[13px]">
                  <span className={cn('font-mono text-xs', isBlocked ? 'text-destructive' : 'text-muted-foreground')}>
                    #{d.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{d.title}</span>
                  <span className={cn('text-xs', isBlocked ? 'text-destructive' : 'text-muted-foreground')}>
                    {isBlocked ? `blocked (${d.stage})` : stageLabel(d.stage)}
                  </span>
                  {isBlocked && (
                    <Button size="xs" variant="ghost" onClick={() => save({ dependsOn: depIds.filter((id) => id !== d.id) })}>
                      <Unlink />
                      Remove dependency
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <SectionTitle>Touches</SectionTitle>
        {editable ? (
          <CommitInput
            mono
            value={task.touches.join(', ')}
            placeholder="src/auth/, src/routes/login.tsx"
            onCommit={(v) => save({ touches: splitList(v ?? '') })}
          />
        ) : task.touches.length ? (
          <div className="flex flex-wrap gap-1">
            {task.touches.map((t) => (
              <span key={t} className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {t}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground/70 italic">Not specified.</p>
        )}
      </section>

      <section>
        <SectionTitle>Details</SectionTitle>
        <dl className="grid grid-cols-[8.5rem_1fr] items-center gap-x-3">
          {milestones.length > 0 && (
            <Prop label="Milestone">
              {task.stage !== 'discarded' ? (
                <Select
                  size="sm"
                  className="w-64"
                  value={task.milestoneId ?? 'none'}
                  onValueChange={(v) => save({ milestoneId: v === 'none' ? null : v })}
                  options={[
                    { value: 'none', label: 'No milestone' },
                    ...milestones.map((m) => ({ value: m.id, label: `M${m.number} · ${m.title}` })),
                  ]}
                />
              ) : (
                (milestones.find((m) => m.id === task.milestoneId)?.title ?? '—')
              )}
            </Prop>
          )}
          <Prop label="Category">
            {editable ? (
              <Select size="sm" className="w-40" value={task.category} onValueChange={(category) => save({ category })} options={opts(CATEGORIES)} />
            ) : (
              task.category
            )}
          </Prop>
          <Prop label="Complexity">
            {editable ? (
              <Select size="sm" className="w-40" value={task.complexity} onValueChange={(complexity) => save({ complexity })} options={opts(COMPLEXITIES)} />
            ) : (
              task.complexity
            )}
          </Prop>
          <Prop label="Priority">
            {editable ? (
              <Select size="sm" className="w-40" value={task.priority} onValueChange={(priority) => save({ priority })} options={opts(PRIORITIES)} />
            ) : (
              task.priority
            )}
          </Prop>
          {task.branch && (
            <Prop label="Branch">
              <span className="font-mono text-xs break-all">{task.branch}</span>
            </Prop>
          )}
          {task.worktreePath && (
            <Prop label="Worktree">
              <span className="font-mono text-xs break-all">{task.worktreePath}</span>
            </Prop>
          )}
          {task.threadLink && (
            <Prop label="Task thread">
              <a href={task.threadLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                Open in T3 <ExternalLink className="size-3" />
              </a>
              {task.lastThreadStatus && <span className="ml-2 font-mono text-[11px] text-muted-foreground">{task.lastThreadStatus}</span>}
            </Prop>
          )}
          {task.prUrl && (
            <Prop label="Pull request">
              <a href={task.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                <GitPullRequest className="size-3" /> {task.prUrl.replace(/^https?:\/\//, '')}
              </a>
            </Prop>
          )}
          {(task.fixRound > 0 || task.reviewRound > 0) && (
            <Prop label="Rounds">
              <span className="text-xs">
                review {task.reviewRound} · fix {task.fixRound}/{board.maxFixRounds}
              </span>
            </Prop>
          )}
          {task.planKey && (
            <Prop label="From plan">
              {plan ? (
                <Link to={planPath(board.slug, plan.id)} className="inline-flex min-w-0 max-w-full items-baseline gap-1.5 text-primary hover:underline">
                  <span className="shrink-0 font-mono text-xs">
                    P{plan.number} · {task.planKey}
                  </span>
                  <span className="truncate">{planTitle(plan)}</span>
                </Link>
              ) : (
                <span className="font-mono text-xs">{task.planKey}</span>
              )}
            </Prop>
          )}
          <Prop label="Created">
            <span title={absoluteTime(task.createdAt)}>{relativeTime(task.createdAt)}</span>
          </Prop>
          {task.startedAt && (
            <Prop label="Started">
              <span title={absoluteTime(task.startedAt)}>{relativeTime(task.startedAt)}</span>
            </Prop>
          )}
          {task.completedAt && (
            <Prop label="Completed">
              <span title={absoluteTime(task.completedAt)}>{relativeTime(task.completedAt)}</span>
            </Prop>
          )}
        </dl>
      </section>

      <section>
        <SectionTitle>Overrides</SectionTitle>
        <dl className="grid grid-cols-[8.5rem_1fr] items-center gap-x-3 gap-y-1.5">
          <dt className="text-xs text-muted-foreground">Provider</dt>
          <dd>
            <ProviderSelect
              size="sm"
              className="max-w-64"
              value={task.providerOverride}
              noneLabel="Board default"
              onChange={(providerOverride) => {
                // Drop a model override the new provider doesn't offer.
                const offered = catalog && modelsOf(catalog, providerOverride ?? board.defaultProvider);
                const keep = !offered || !task.modelOverride || offered.some((m) => m.slug === task.modelOverride);
                save(keep ? { providerOverride } : { providerOverride, modelOverride: null });
              }}
            />
          </dd>
          <dt className="text-xs text-muted-foreground">Model</dt>
          <dd>
            <ModelSelect
              size="sm"
              className="max-w-64"
              provider={task.providerOverride ?? board.defaultProvider}
              value={task.modelOverride}
              noneLabel={task.providerOverride && task.providerOverride !== board.defaultProvider ? 'Provider default' : 'Board default'}
              onChange={(modelOverride) => save({ modelOverride })}
            />
          </dd>
          <dt className="text-xs text-muted-foreground">Skip AI review</dt>
          <dd className="flex items-center gap-2">
            <Switch
              checked={task.skipAiReview}
              disabled={!board.aiReview}
              onCheckedChange={(skipAiReview) => save({ skipAiReview })}
            />
            {!board.aiReview && <span className="text-xs text-muted-foreground">AI review is off for this board</span>}
          </dd>
        </dl>
      </section>
    </div>
  );
}
