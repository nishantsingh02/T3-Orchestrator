import type { BoardView, TaskView } from '@t3-orchestra/shared';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  GitBranch,
  Info,
  Palette,
  RefreshCw,
  TriangleExclamationPoint,
  Unlink,
  X,
} from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { usePatchTask, useTaskDetail } from '@/api/tasks';
import { useBoardContext, type DrawerTab } from '@/components/board/BoardContext';
import { currentThreadLink } from '@/components/tasks/TaskCard';
import { openFindingsText } from '@/components/tasks/StatusLine';
import type { useTaskActions } from '@/components/tasks/useTaskActions';
import { OpenInVsCodeButton } from '@/components/run/OpenInVsCodeButton';
import { RunButton } from '@/components/run/RunButton';
import { Button } from '@/components/ui/button';
import { Dialog, SheetContent } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tip } from '@/components/ui/tooltip';
import { isTypingTarget } from '@/lib/hotkeys';
import { ATTENTION_LABELS, LANE_LABELS, LANE_STYLE, laneFor, reasonLabel } from '@/lib/stage';
import { cn, firstLine } from '@/lib/utils';
import { ActivityTab } from './ActivityTab';
import { Composer } from './Composer';
import { OverviewTab } from './OverviewTab';
import { ReviewTab } from './ReviewTab';
import { StageActions } from './StageActions';

type Run = ReturnType<typeof useTaskActions>['run'];

interface Props {
  board: BoardView;
  task: TaskView | undefined;
  loading: boolean;
  num: number;
  tasks: TaskView[];
  /** Visible board order, for [ and ]. */
  order: TaskView[];
  tab: DrawerTab | null;
  onTabChange: (tab: DrawerTab) => void;
  onClose: () => void;
  onNavigate: (task: TaskView) => void;
  run: Run;
}

export function TaskDrawer(props: Props) {
  const { task, order, onNavigate } = props;
  const contentRef = useRef<HTMLDivElement>(null);
  const index = task ? order.findIndex((t) => t.id === task.id) : -1;
  const prev = index > 0 ? order[index - 1] : undefined;
  const next = index >= 0 && index < order.length - 1 ? order[index + 1] : undefined;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
    if (e.key === '[' && prev) {
      e.preventDefault();
      onNavigate(prev);
    } else if (e.key === ']' && next) {
      e.preventDefault();
      onNavigate(next);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent
        ref={contentRef}
        tabIndex={-1}
        data-hotkeys-allowed=""
        aria-describedby={undefined}
        onKeyDown={onKeyDown}
        onEscapeKeyDown={(e) => {
          // Esc while editing a field leaves the field instead of closing the drawer.
          const el = document.activeElement;
          if (isTypingTarget(el)) {
            e.preventDefault();
            (el as HTMLElement).blur();
          }
        }}
        onOpenAutoFocus={(e) => {
          // Focus the sheet (so [ ] and Esc work) rather than the first field.
          e.preventDefault();
          contentRef.current?.focus();
        }}
      >
        {task ? (
          <DrawerBody {...props} task={task} prev={prev} next={next} />
        ) : (
          <div className="flex flex-col gap-3 p-5">
            <D.Title className="sr-only">Task #{props.num}</D.Title>
            <div className="flex justify-end">
              <Button variant="ghost" size="icon-sm" onClick={props.onClose} aria-label="Close">
                <X />
              </Button>
            </div>
            {props.loading ? (
              <>
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="mt-4 h-40" />
              </>
            ) : (
              <p className="text-[13px] text-muted-foreground">Task #{props.num} isn't on this board.</p>
            )}
          </div>
        )}
      </SheetContent>
    </Dialog>
  );
}

function InlineTitle({ task, editable }: { task: TaskView; editable: boolean }) {
  const patch = usePatchTask();
  const [draft, setDraft] = useState(task.title);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(task.title);
  }, [task.title]);

  if (!editable) {
    return <span className="break-words">{task.title}</span>;
  }
  const commit = () => {
    const v = draft.trim();
    if (!v) setDraft(task.title);
    else if (v !== task.title) patch.mutate({ task, patch: { title: v } });
  };
  return (
    <textarea
      rows={1}
      value={draft}
      maxLength={120}
      aria-label="Task title"
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, ' '))}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') setDraft(task.title);
      }}
      className="field-sizing-content -mx-1 w-full resize-none rounded-md border border-transparent bg-transparent px-1 py-0.5 leading-snug outline-none hover:border-border focus:border-ring focus:ring-2 focus:ring-ring/25"
    />
  );
}

function DrawerBody({
  task,
  board,
  tasks,
  tab,
  onTabChange,
  onClose,
  onNavigate,
  run,
  prev,
  next,
}: Props & { task: TaskView; prev?: TaskView; next?: TaskView }) {
  const { openDesigns } = useBoardContext();
  const detail = useTaskDetail(task.id);
  const merged = detail.data ? { ...detail.data, ...task } : null;
  const lane = laneFor(task);
  const style = LANE_STYLE[lane];
  const editable = task.stage === 'backlog' || task.stage === 'ready';
  const link = currentThreadLink(task);
  const reason = reasonLabel(task.stageReason);
  const defaultTab: DrawerTab = task.stage === 'human_review' || task.stage === 'done' ? 'review' : 'overview';
  const activeTab = tab ?? defaultTab;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset scroll when switching tasks.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [task.id]);

  const showComposer = task.stage === 'human_review' || task.stage === 'failed';
  const failedMsg = task.stage === 'failed' ? task.lastMessage : null;
  const openFindings = openFindingsText(task.findings, true);

  return (
    <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as DrawerTab)} className="flex min-h-0 flex-1 flex-col">
      <header className={cn('shrink-0 border-t-2 px-5 pt-3', style.border)}>
        <div className="flex items-start gap-2">
          <D.Title className="flex min-w-0 flex-1 items-start gap-2 text-[16px] leading-snug font-semibold">
            <span className="mt-0.5 shrink-0 font-mono text-[13px] font-normal text-muted-foreground tabular">
              #{task.number}
            </span>
            <span className="min-w-0 flex-1">
              <InlineTitle task={task} editable={editable} />
            </span>
          </D.Title>
          <div className="-mr-2 flex shrink-0 items-center">
            <Tip content={<span>Previous <Kbd>[</Kbd></span>}>
              <Button variant="ghost" size="icon-sm" disabled={!prev} onClick={() => prev && onNavigate(prev)} aria-label="Previous task">
                <ChevronLeft />
              </Button>
            </Tip>
            <Tip content={<span>Next <Kbd>]</Kbd></span>}>
              <Button variant="ghost" size="icon-sm" disabled={!next} onClick={() => next && onNavigate(next)} aria-label="Next task">
                <ChevronRight />
              </Button>
            </Tip>
            <Tip content={<span>Close <Kbd>Esc</Kbd></span>}>
              <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
                <X />
              </Button>
            </Tip>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className={cn('inline-flex h-5 items-center gap-1.5 rounded-[5px] px-1.5 text-2xs font-semibold', style.bg, style.text)}>
            <span className={cn('size-1.5 rounded-full', style.dot)} />
            {LANE_LABELS[lane]}
          </span>
          {lane === 'needs_input' && (
            <span className="inline-flex h-5 items-center rounded-[5px] border border-border px-1.5 text-2xs text-muted-foreground">
              {LANE_LABELS[laneFor({ stage: task.stage, attention: null })]}
            </span>
          )}
          {reason && (
            <span
              className={cn(
                'inline-flex h-5 items-center rounded-[5px] border px-1.5 text-2xs font-medium',
                task.stage === 'failed' || task.stageReason === 'merge_conflict'
                  ? 'border-destructive/35 text-destructive'
                  : task.stageReason === 'ai_passed'
                    ? 'border-success/35 text-success'
                    : task.stageReason === 'ai_unresolved' || task.stageReason === 'review_failed'
                      ? 'border-warning/35 text-warning'
                      : 'border-border text-muted-foreground',
              )}
            >
              {reason}
              {task.stageReason === 'ai_unresolved' && openFindings && ` · ${openFindings}`}
            </span>
          )}
          {task.branch && (
            <span className="ml-1 flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate" title={task.branch}>
                {task.branch}
              </span>
            </span>
          )}
        </div>

        <div className="mt-3 flex items-start gap-2 pb-3">
          <div className="min-w-0 flex-1">
            <StageActions task={task} board={board} run={run} onEdit={() => onTabChange('overview')} />
          </div>
          {task.worktreePath && task.stage !== 'discarded' && (
            <div className="flex shrink-0 items-center gap-1.5">
              <OpenInVsCodeButton board={board} task={task} compact />
              <RunButton board={board} task={task} />
            </div>
          )}
        </div>

        {lane === 'needs_input' && (
          <div className="mb-3 flex items-center gap-3 rounded-md border border-stage-needs-input/40 bg-stage-needs-input/10 px-3 py-2.5">
            <span className="text-lg leading-none">{task.attention === 'approval' ? '🔐' : '❓'}</span>
            <div className="min-w-0 flex-1 text-[13px]">
              <p className="font-medium">The agent is waiting for you in T3.</p>
              <p className="text-xs text-muted-foreground">
                {task.attention ? ATTENTION_LABELS[task.attention].replace(/^\S+\s/, '') : 'Waiting'}
                {task.stage === 'ai_review' && ' (reviewer thread)'} — answer in T3 and the card moves back on its own.
              </p>
            </div>
            {link && (
              <Button size="sm" variant="warning" asChild>
                <a href={link} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  Open in T3
                </a>
              </Button>
            )}
          </div>
        )}

        {task.stageReason === 'design_options' && task.stage === 'human_review' && (
          <div className="mb-3 flex items-center gap-3 rounded-md border border-stage-human-review/40 bg-stage-human-review/10 px-3 py-2.5">
            <Palette className="size-4 shrink-0 text-stage-human-review" />
            <div className="min-w-0 flex-1 text-[13px]">
              <p className="font-medium">
                The agent made {task.design?.options ?? 'some'} design options and waits for your pick.
              </p>
              <p className="text-xs text-muted-foreground">Pick one or combine several; it builds your choice next.</p>
            </div>
            <Button size="sm" onClick={() => openDesigns(task)}>
              <Palette />
              Pick a design
            </Button>
          </div>
        )}

        {failedMsg !== null && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-[13px]">
            <p className="flex items-center gap-1.5 font-medium text-destructive">
              <TriangleExclamationPoint className="size-3.5" />
              {reason ?? 'Failed'}
            </p>
            {firstLine(failedMsg) && (
              <p className="mt-1 line-clamp-4 text-xs whitespace-pre-wrap text-muted-foreground">{failedMsg}</p>
            )}
          </div>
        )}

        {task.stageReason === 'merge_conflict' && task.stage === 'human_review' && (
          <div className="mb-3 flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-[13px]">
            <TriangleExclamationPoint className="size-4 shrink-0 text-destructive" />
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              <span className="font-medium text-destructive">Merging conflicted with {board.baseBranch}; the merge was aborted.</span>{' '}
              Update branch asks the agent to merge {board.baseBranch} into its branch and resolve the conflicts.
            </p>
            <Button size="sm" variant="warning" onClick={() => void run(task, 'update-branch')}>
              <RefreshCw />
              Update branch
            </Button>
          </div>
        )}

        {task.blockedBy.length > 0 && (task.stage === 'backlog' || task.stage === 'ready') && (
          <BlockedBanner task={task} />
        )}

        {task.activitySinceReview && task.stage !== 'implementing' && task.stage !== 'ai_review' && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-info/30 bg-info/8 px-3 py-2 text-xs">
            <Info className="size-3.5 shrink-0 text-info" />
            <span className="text-muted-foreground">
              <span className="font-medium text-info">Agent activity since review.</span> The diff was re-read.
            </span>
          </div>
        )}

        <TabsList className="-mx-5 px-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">
            Activity
            {merged && merged.runs.length > 0 && <span className="font-mono text-[10.5px] text-muted-foreground">{merged.runs.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="review">
            Review
            {task.findings.total > 0 && (
              <span className={cn('font-mono text-[10.5px]', openFindings ? 'text-warning' : 'text-muted-foreground')}>
                {task.findings.total}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5 scrollbar-thin">
        <TabsContent value="overview">
          <OverviewTab key={task.id} task={merged ?? task} board={board} tasks={tasks} />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityTab task={merged} />
        </TabsContent>
        <TabsContent value="review">
          <ReviewTab key={task.id} task={task} detail={merged} board={board} run={run} />
        </TabsContent>
      </div>

      {showComposer && <Composer key={task.id} task={task} run={run} />}
    </Tabs>
  );
}

function BlockedBanner({ task }: { task: TaskView }) {
  const patch = usePatchTask();
  const remaining = (id: string) => task.deps.map((d) => d.id).filter((x) => x !== id);
  return (
    <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs">
      <p className="font-medium text-destructive">This task won't auto-start: a dependency failed or was discarded.</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {task.blockedBy.map((d) => (
          <li key={d.id} className="flex items-center gap-2">
            <span className="font-mono text-destructive">#{d.number}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {d.title} ({d.stage})
            </span>
            <Button size="xs" variant="ghost" onClick={() => patch.mutate({ task, patch: { dependsOn: remaining(d.id) } })}>
              <Unlink />
              Remove dependency
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
