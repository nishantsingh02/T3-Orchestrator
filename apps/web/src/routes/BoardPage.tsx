import { COLUMN_ORDER, isActiveStage, type MilestoneView, type TaskView } from '@t3-orchestra/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useMatch, useNavigate, useParams, useSearchParams } from 'react-router';
import { useBoard, useBoards } from '@/api/boards';
import { isApiError } from '@/api/client';
import { useMilestones } from '@/api/milestones';
import { useSettings } from '@/api/settings';
import { useBoardTasks } from '@/api/tasks';
import { BoardColumns } from '@/components/board/BoardColumns';
import {
  BoardContext,
  boardModeFrom,
  boardModePath,
  type BoardContextValue,
  type DesignOptionRef,
  type DrawerTab,
} from '@/components/board/BoardContext';
import { BoardSettingsDialog } from '@/components/board/BoardSettingsDialog';
import { BoardSwitcher } from '@/components/board/BoardSwitcher';
import { BoardToolbar } from '@/components/board/BoardToolbar';
import { NewTaskDialog } from '@/components/board/NewTaskDialog';
import { IdeasView } from '@/components/ideas/IdeasView';
import { ImportBanner, ProjectContextDialog } from '@/components/import/ProjectImport';
import { InsightsView } from '@/components/insights/InsightsView';
import { MarketingView } from '@/components/marketing/MarketingView';
import { OverviewView } from '@/components/overview/OverviewView';
import { planPath } from '@/components/plans/model';
import { PlansView } from '@/components/plans/PlansView';
import { RoadmapView } from '@/components/roadmap/RoadmapView';
import { SecurityView } from '@/components/security/SecurityView';
import { ContextView } from '@/components/context/ContextView';
import { DesignGallery } from '@/components/design/DesignGallery';
import { TaskDrawer } from '@/components/drawer/TaskDrawer';
import { AppHeader } from '@/components/layout/AppHeader';
import { PlanComposerDialog } from '@/components/plan/PlanComposerDialog';
import { useTaskActions } from '@/components/tasks/useTaskActions';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/spinner';
import { useHotkeys } from '@/lib/hotkeys';
import { laneFor, type BoardLane } from '@/lib/stage';
import { readJson, writeJson } from '@/lib/storage';
import { toMs } from '@/lib/time';

const DRAWER_TABS: ReadonlySet<string> = new Set(['overview', 'activity', 'review']);

function matchesFilter(t: TaskView, q: string, milestones: ReadonlyMap<string, MilestoneView>): boolean {
  if (!q) return true;
  const needle = q.toLowerCase().trim();
  if (/^#?\d+$/.test(needle)) return String(t.number).startsWith(needle.replace('#', ''));
  const m = t.milestoneId ? milestones.get(t.milestoneId) : undefined;
  return (
    t.title.toLowerCase().includes(needle) ||
    (m !== undefined && (`m${m.number}` === needle || m.title.toLowerCase().includes(needle))) ||
    t.category.includes(needle) ||
    t.priority === needle ||
    t.complexity === needle ||
    (t.branch?.toLowerCase().includes(needle) ?? false) ||
    t.touches.some((p) => p.toLowerCase().includes(needle))
  );
}

function sortLane(lane: BoardLane, list: TaskView[]): TaskView[] {
  if (lane === 'done') return list.sort((a, b) => (toMs(b.completedAt) ?? 0) - (toMs(a.completedAt) ?? 0) || b.number - a.number);
  if (lane === 'discarded') return list.sort((a, b) => (toMs(b.updatedAt) ?? 0) - (toMs(a.updatedAt) ?? 0));
  return list.sort((a, b) => a.position - b.position || a.number - b.number);
}

const EMPTY: TaskView[] = [];
const NO_MILESTONES: MilestoneView[] = [];

export function BoardPage() {
  const { boardSlug } = useParams();
  const drawerMatch = useMatch('/b/:boardSlug/t/:num');
  const viewDrawerMatch = useMatch('/b/:boardSlug/:view/t/:num');
  const viewMatch = useMatch('/b/:boardSlug/:view/*');
  const planMatch = useMatch('/b/:boardSlug/plans/:planId');
  const planDrawerMatch = useMatch('/b/:boardSlug/plans/:planId/t/:num');
  const mode = boardModeFrom(viewMatch?.params.view);
  const planId = planMatch?.params.planId ?? planDrawerMatch?.params.planId ?? null;
  const numParam = drawerMatch?.params.num ?? viewDrawerMatch?.params.num ?? planDrawerMatch?.params.num;
  const num = numParam ? Number(numParam) : null;
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab = tabParam && DRAWER_TABS.has(tabParam) ? (tabParam as DrawerTab) : null;
  const navigate = useNavigate();

  const boardQ = useBoard(boardSlug);
  const board = boardQ.data;
  const tasksQ = useBoardTasks(board?.id);
  const milestones = useMilestones(board?.id).data ?? NO_MILESTONES;
  const milestoneById = useMemo(() => new Map(milestones.map((m) => [m.id, m])), [milestones]);
  const settings = useSettings();
  const boards = useBoards();
  const { run, runMany } = useTaskActions();

  const [filter, setFilter] = useState('');
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<BoardLane>>(new Set());
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planPrompt, setPlanPrompt] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  // Per-board view preferences.
  const boardId = board?.id;
  useEffect(() => {
    if (!boardId) return;
    setCollapsed(new Set(readJson<BoardLane[]>(`collapsed:${boardId}`, [])));
    setShowDiscarded(readJson<boolean>(`showDiscarded:${boardId}`, false));
  }, [boardId]);

  const toggleCollapse = (lane: BoardLane) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      if (boardId) writeJson(`collapsed:${boardId}`, [...next]);
      return next;
    });
  const toggleDiscarded = () =>
    setShowDiscarded((v) => {
      if (boardId) writeJson(`showDiscarded:${boardId}`, !v);
      return !v;
    });

  const tasks = tasksQ.data ?? EMPTY;
  const activeTasks = useMemo(() => tasks.filter((t) => isActiveStage(t.stage)), [tasks]);
  const activeCount = activeTasks.length;
  const needsYou = useMemo(
    () => tasks.filter((t) => t.stage !== 'discarded' && (t.attention !== null || t.stage === 'human_review')).length,
    [tasks],
  );
  const discardedCount = useMemo(() => tasks.filter((t) => t.stage === 'discarded').length, [tasks]);

  const { lanes, byLane } = useMemo(() => {
    const groups: Record<BoardLane, TaskView[]> = {
      backlog: [],
      ready: [],
      running: [],
      needs_input: [],
      ai_review: [],
      human_review: [],
      done: [],
      failed: [],
      discarded: [],
    };
    let failedTotal = 0;
    for (const t of tasks) {
      const lane = laneFor(t);
      if (lane === 'failed') failedTotal++;
      if (matchesFilter(t, filter, milestoneById)) groups[lane].push(t);
    }
    for (const lane of Object.keys(groups) as BoardLane[]) sortLane(lane, groups[lane]);
    const visible: BoardLane[] = COLUMN_ORDER.filter((c) => c !== 'failed' || failedTotal > 0);
    if (showDiscarded) visible.push('discarded');
    return { lanes: visible, byLane: groups };
  }, [tasks, filter, showDiscarded, milestoneById]);

  const order = useMemo(
    () => lanes.filter((l) => !collapsed.has(l)).flatMap((l) => byLane[l]),
    [lanes, byLane, collapsed],
  );

  const drawerTask = num !== null ? tasks.find((t) => t.number === num) : undefined;

  // The drawer opens over the current page, so on a plan it keeps the plan: /b/:slug/plans/:planId/t/:num.
  const basePath = board ? (planId ? planPath(board.slug, planId) : boardModePath(board.slug, mode)) : '';
  const openTask = useCallback(
    (t: TaskView, nextTab?: DrawerTab) => {
      if (!basePath) return;
      navigate(`${basePath}/t/${t.number}${nextTab ? `?tab=${nextTab}` : ''}`);
    },
    [basePath, navigate],
  );

  const globalActive = useMemo(() => {
    const others = (boards.data ?? []).filter((b) => b.id !== board?.id).reduce((s, b) => s + b.counts.active, 0);
    return others + activeCount;
  }, [boards.data, board?.id, activeCount]);

  const openPlanComposer = useCallback((prompt?: string) => {
    setPlanPrompt(prompt);
    setPlanOpen(true);
  }, []);

  const [designsFor, setDesignsFor] = useState<{ taskId: string; at?: DesignOptionRef } | null>(null);
  const openDesigns = useCallback((t: TaskView, at?: DesignOptionRef) => {
    setDesignsFor({ taskId: t.id, at: at && { round: at.round, file: at.file } });
  }, []);
  const designTask = designsFor ? tasks.find((t) => t.id === designsFor.taskId) : undefined;

  const pauseAll = settings.data?.pauseAll ?? false;
  const ctx = useMemo<BoardContextValue | null>(
    () =>
      board
        ? { board, tasks, activeTasks, activeCount, pauseAll, milestones, openTask, openDesigns, openPlanComposer, run, runMany }
        : null,
    [board, tasks, activeTasks, activeCount, pauseAll, milestones, openTask, openDesigns, openPlanComposer, run, runMany],
  );

  useHotkeys(
    {
      n: () => board && setNewTaskOpen(true),
      p: () => board && openPlanComposer(),
      '/': () => num === null && mode === 'board' && filterRef.current?.focus(),
    },
    { enabled: Boolean(board) },
  );

  if (boardQ.isError && isApiError(boardQ.error) && (boardQ.error.status === 404 || boardQ.error.code === 'NOT_FOUND')) {
    return (
      <div className="flex h-full flex-col">
        <AppHeader />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="text-[15px] font-medium">Board not found</p>
          <p className="text-[13px] text-muted-foreground">
            There's no board called <span className="font-mono">{boardSlug}</span>. It may have been archived.
          </p>
          <Button asChild variant="secondary" size="sm">
            <Link to="/">All boards</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!board || !ctx) {
    return (
      <div className="flex h-full flex-col">
        <AppHeader>
          <Skeleton className="h-4 w-32" />
        </AppHeader>
        <div className="flex flex-col gap-2 border-b border-border px-3 py-3">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="flex gap-2 overflow-hidden p-3">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-72 w-[256px] shrink-0" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <BoardContext.Provider value={ctx}>
      <div className="flex h-full min-h-0 flex-col">
        <AppHeader>
          <BoardSwitcher board={board} mode={mode} />
        </AppHeader>
        <BoardToolbar
          board={board}
          mode={mode}
          onMode={(m) => navigate(boardModePath(board.slug, m))}
          activeCount={activeCount}
          needsYou={needsYou}
          globalActive={globalActive}
          globalMax={settings.data?.globalMaxParallel ?? null}
          pauseAll={pauseAll}
          filter={filter}
          onFilter={setFilter}
          filterRef={filterRef}
          showDiscarded={showDiscarded}
          onToggleDiscarded={toggleDiscarded}
          discardedCount={discardedCount}
          onNewTask={() => setNewTaskOpen(true)}
          onSettings={() => setSettingsOpen(true)}
        />
        {board.projectImport && (
          <div className="px-3 pt-3 empty:hidden">
            <ImportBanner board={board} onView={() => setContextOpen(true)} onPlan={openPlanComposer} />
          </div>
        )}
        <main className={mode === 'board' ? 'min-h-0 flex-1 pt-3' : 'min-h-0 flex-1'}>
          {mode === 'plans' ? (
            <PlansView planId={planId} loading={tasksQ.isLoading} />
          ) : mode === 'overview' ? (
            <OverviewView loading={tasksQ.isLoading} />
          ) : mode === 'roadmap' ? (
            <RoadmapView loading={tasksQ.isLoading} />
          ) : mode === 'insights' ? (
            <InsightsView />
          ) : mode === 'ideas' ? (
            <IdeasView />
          ) : mode === 'marketing' ? (
            <MarketingView />
          ) : mode === 'security' ? (
            <SecurityView />
          ) : mode === 'context' ? (
            <ContextView />
          ) : tasksQ.isLoading ? (
            <div className="flex gap-2 overflow-hidden px-3">
              {Array.from({ length: 7 }, (_, i) => (
                <Skeleton key={i} className="h-72 w-[256px] shrink-0" />
              ))}
            </div>
          ) : (
            <BoardColumns
              lanes={lanes}
              byLane={byLane}
              selectedId={drawerTask?.id ?? null}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              onAddTask={() => setNewTaskOpen(true)}
            />
          )}
        </main>
      </div>

      {num !== null && (
        <TaskDrawer
          board={board}
          task={drawerTask}
          loading={tasksQ.isLoading}
          num={num}
          tasks={tasks}
          order={order}
          tab={tab}
          onTabChange={(t) => setSearchParams({ tab: t }, { replace: true })}
          onClose={() => navigate(basePath)}
          onNavigate={(t) => navigate(`${basePath}/t/${t.number}${tab ? `?tab=${tab}` : ''}`, { replace: true })}
          run={run}
        />
      )}

      {designTask && <DesignGallery key={designTask.id} task={designTask} at={designsFor?.at} onClose={() => setDesignsFor(null)} />}

      <NewTaskDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} board={board} tasks={tasks} />
      <PlanComposerDialog open={planOpen} onOpenChange={setPlanOpen} board={board} initialPrompt={planPrompt} />
      <BoardSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        board={board}
        onViewContext={() => {
          setSettingsOpen(false);
          setContextOpen(true);
        }}
      />
      <ProjectContextDialog
        board={board}
        open={contextOpen}
        onOpenChange={setContextOpen}
        onPlan={openPlanComposer}
        onEditBrief={() => setSettingsOpen(true)}
      />
    </BoardContext.Provider>
  );
}
