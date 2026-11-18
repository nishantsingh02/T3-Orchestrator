// Board overview (progress, scope, pace, hold-ups), computed from the board's task list.
import { columnFor } from './columns.ts';
import type { Column } from './enums.ts';
import { overlapPaths } from './overlap.ts';
import type { BoardView, TaskDepView, TaskView } from './views.ts';

const DAY_MS = 86_400_000;

/** Middle value (mean of the two middle values for an even count); null for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export type HoldReason =
  | { kind: 'blocked'; deps: TaskDepView[] }
  | { kind: 'waiting'; deps: TaskDepView[] }
  | { kind: 'backlog' }
  | { kind: 'auto_run_off' }
  | { kind: 'paused' }
  | { kind: 'no_slot'; active: number; max: number }
  | { kind: 'overlap'; tasks: number[]; paths: string[] }
  | { kind: 'ready' };
export type HoldKind = HoldReason['kind'];

/** Hold-up groups in the Overview, most actionable first. */
export const HOLD_ORDER: readonly HoldKind[] = [
  'ready',
  'no_slot',
  'overlap',
  'waiting',
  'blocked',
  'auto_run_off',
  'paused',
  'backlog',
];

type BoardGate = Pick<BoardView, 'autoRun' | 'maxParallel' | 'avoidOverlap'>;

/**
 * Why a Backlog or Ready task isn't running, checked in the scheduler's order (spec §7):
 * dependencies, auto-run, the global pause, a free slot, then overlapping work (which a "run next"
 * task skips). Null for other stages. `activeTasks` are the board's tasks holding a slot (implementing + ai_review).
 */
export function holdReason(
  task: Pick<TaskView, 'stage' | 'blockedBy' | 'waitingOn' | 'touches' | 'runNext'>,
  board: BoardGate,
  activeTasks: ReadonlyArray<Pick<TaskView, 'number' | 'touches'>>,
  pauseAll: boolean,
): HoldReason | null {
  if (task.stage !== 'backlog' && task.stage !== 'ready') return null;
  if (task.blockedBy.length > 0) return { kind: 'blocked', deps: task.blockedBy };
  if (task.waitingOn.length > 0) return { kind: 'waiting', deps: task.waitingOn };
  if (task.stage === 'backlog') return { kind: 'backlog' };
  if (!board.autoRun) return { kind: 'auto_run_off' };
  if (pauseAll) return { kind: 'paused' };
  if (activeTasks.length >= board.maxParallel) return { kind: 'no_slot', active: activeTasks.length, max: board.maxParallel };
  if (board.avoidOverlap && !task.runNext) {
    const overlaps = activeTasks.filter((t) => overlapPaths(task.touches, t.touches).length > 0);
    if (overlaps.length > 0) {
      const paths = [...new Set(overlaps.flatMap((t) => overlapPaths(task.touches, t.touches)))];
      return { kind: 'overlap', tasks: overlaps.map((t) => t.number), paths };
    }
  }
  return { kind: 'ready' };
}

export type OverviewColumn = Exclude<Column, 'hidden'>;

export interface Tally {
  total: number;
  done: number;
}

/** The tasks of one accepted plan (planId null: tasks added by hand) and the follow-ups they led to. */
export interface ScopeGroup {
  planId: string | null;
  planned: Tally;
  followUps: Tally;
}

export interface OverviewDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  done: number;
  added: number;
}

export interface OverviewPace {
  /** Days the pace is measured over: the last 7, or fewer on a newer board. */
  windowDays: number;
  done: number;
  perDay: number;
  /** Days the remaining tasks take at this pace; null when nothing finished in the window. */
  etaDays: number | null;
}

export interface Unblocker {
  task: TaskView;
  /** Unfinished tasks that wait on this one, directly or through other tasks. */
  waiting: number;
}

export interface BoardOverview {
  /** Every task but the discarded ones. */
  total: number;
  done: number;
  remaining: number;
  byColumn: Record<OverviewColumn, number>;
  scope: ScopeGroup[];
  days: OverviewDay[];
  pace: OverviewPace;
  holds: Array<{ kind: HoldKind; tasks: TaskView[] }>;
  unblockers: Unblocker[];
  /** Needs Input, then Failed, then Human Review (highest review score first). */
  needsYou: TaskView[];
  /** Running and in AI review, longest-running first. */
  running: TaskView[];
  /** Median time from a task's first start to Done. */
  cycleMs: number | null;
  autoApproved: number;
}

export interface OverviewOptions {
  board: BoardGate;
  pauseAll: boolean;
  now?: number;
  /** Most days the daily series covers (default 14). It always covers at least the last 7. */
  maxDays?: number;
}

/** Local calendar day of a timestamp, YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function addLocalDays(dayStart: number, n: number): number {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

const NEEDS_YOU_RANK: Partial<Record<OverviewColumn, number>> = { needs_input: 0, failed: 1, human_review: 2 };

export function boardOverview(all: readonly TaskView[], o: OverviewOptions): BoardOverview {
  const now = o.now ?? Date.now();
  const tasks = all.filter((t) => t.stage !== 'discarded');
  const byId = new Map(all.map((t) => [t.id, t]));
  const isDone = (t: TaskView) => t.stage === 'done';

  const byColumn: Record<OverviewColumn, number> = {
    backlog: 0,
    ready: 0,
    running: 0,
    needs_input: 0,
    ai_review: 0,
    human_review: 0,
    done: 0,
    failed: 0,
  };
  for (const t of tasks) {
    const col = columnFor(t);
    if (col !== 'hidden') byColumn[col]++;
  }
  const done = byColumn.done;

  // Scope: a follow-up counts toward the plan its chain of follow-ups started from.
  const rootOf = (t: TaskView): TaskView => {
    const seen = new Set<string>();
    let cur = t;
    while (cur.followUpOf && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = byId.get(cur.followUpOf);
      if (!parent) break;
      cur = parent;
    }
    return cur;
  };
  const groups = new Map<string | null, ScopeGroup>();
  for (const t of tasks) {
    const planId = rootOf(t).planId;
    const g = groups.get(planId) ?? { planId, planned: { total: 0, done: 0 }, followUps: { total: 0, done: 0 } };
    const tally = t.followUpOf ? g.followUps : g.planned;
    tally.total++;
    if (isDone(t)) tally.done++;
    groups.set(planId, g);
  }
  // Plans in the order they were first used; tasks added by hand last.
  const scope = [...groups.values()].sort((a, b) => Number(a.planId === null) - Number(b.planId === null));

  // Daily series: done and added per local day, at least the last 7 days.
  const today = startOfLocalDay(now);
  const maxDays = Math.max(7, o.maxDays ?? 14);
  const created = tasks.map((t) => ms(t.createdAt)).filter((x): x is number => x !== null);
  const first = created.length ? startOfLocalDay(Math.min(...created)) : today;
  let start = Math.max(first, addLocalDays(today, -(maxDays - 1)));
  start = Math.min(start, addLocalDays(today, -6));
  const days: OverviewDay[] = [];
  const dayIndex = new Map<string, OverviewDay>();
  for (let d = start; d <= today; d = addLocalDays(d, 1)) {
    const point = { day: localDay(d), done: 0, added: 0 };
    days.push(point);
    dayIndex.set(point.day, point);
  }
  for (const t of tasks) {
    const c = ms(t.createdAt);
    if (c !== null) {
      const p = dayIndex.get(localDay(c));
      if (p) p.added++;
    }
    const f = isDone(t) ? ms(t.completedAt) : null;
    if (f !== null) {
      const p = dayIndex.get(localDay(f));
      if (p) p.done++;
    }
  }

  // Pace over the last 7 days, or since the first task on a younger board.
  const remaining = tasks.length - done;
  const firstCreated = created.length ? Math.min(...created) : now;
  const windowDays = Math.min(7, Math.max(1, Math.ceil((now - firstCreated) / DAY_MS)));
  const since = now - windowDays * DAY_MS;
  const doneInWindow = tasks.filter((t) => isDone(t) && (ms(t.completedAt) ?? -Infinity) >= since).length;
  const perDay = doneInWindow / windowDays;
  const pace: OverviewPace = {
    windowDays,
    done: doneInWindow,
    perDay,
    etaDays: remaining === 0 ? 0 : perDay > 0 ? remaining / perDay : null,
  };

  // Hold-ups for Backlog and Ready tasks.
  const active = tasks.filter((t) => t.stage === 'implementing' || t.stage === 'ai_review');
  const holdMap = new Map<HoldKind, TaskView[]>();
  for (const t of tasks) {
    const r = holdReason(t, o.board, active, o.pauseAll);
    if (!r) continue;
    const list = holdMap.get(r.kind) ?? [];
    list.push(t);
    holdMap.set(r.kind, list);
  }
  const holds = HOLD_ORDER.filter((k) => holdMap.has(k)).map((kind) => ({
    kind,
    tasks: holdMap.get(kind)!.sort((a, b) => a.position - b.position || a.number - b.number),
  }));

  // Unblockers: unfinished tasks ranked by how many unfinished tasks wait on them.
  const open = tasks.filter((t) => !isDone(t));
  const dependents = new Map<string, string[]>();
  for (const t of open) {
    for (const d of t.deps) dependents.set(d.id, [...(dependents.get(d.id) ?? []), t.id]);
  }
  const unblockers: Unblocker[] = [];
  for (const t of open) {
    const seen = new Set<string>();
    const stack = [...(dependents.get(t.id) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id) || id === t.id) continue;
      seen.add(id);
      stack.push(...(dependents.get(id) ?? []));
    }
    if (seen.size > 0) unblockers.push({ task: t, waiting: seen.size });
  }
  unblockers.sort((a, b) => b.waiting - a.waiting || a.task.number - b.task.number);

  const needsYou = tasks
    .filter((t) => NEEDS_YOU_RANK[columnFor(t) as OverviewColumn] !== undefined)
    .sort(
      (a, b) =>
        NEEDS_YOU_RANK[columnFor(a) as OverviewColumn]! - NEEDS_YOU_RANK[columnFor(b) as OverviewColumn]! ||
        (b.reviewScore ?? -1) - (a.reviewScore ?? -1) ||
        a.number - b.number,
    );

  const running = active
    .filter((t) => t.attention === null)
    .sort((a, b) => (ms(a.activeRun?.startedAt ?? null) ?? now) - (ms(b.activeRun?.startedAt ?? null) ?? now));

  const cycles: number[] = [];
  for (const t of tasks) {
    const s = ms(t.startedAt);
    const f = ms(t.completedAt);
    if (isDone(t) && s !== null && f !== null && f >= s) cycles.push(f - s);
  }

  return {
    total: tasks.length,
    done,
    remaining,
    byColumn,
    scope,
    days,
    pace,
    holds,
    unblockers: unblockers.slice(0, 5),
    needsYou,
    running,
    cycleMs: median(cycles),
    autoApproved: tasks.filter((t) => isDone(t) && t.stageReason === 'auto_approved').length,
  };
}
