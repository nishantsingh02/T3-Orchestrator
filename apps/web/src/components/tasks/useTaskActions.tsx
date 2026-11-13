// Runs task actions (POST /api/tasks/:id/actions/:action) with optimistic stage changes,
// the DEPS_NOT_DONE "start anyway?" flow, and explanatory error toasts.
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  columnFor,
  type BoardView,
  type Stage,
  type TaskAction,
  type TaskActionBody,
  type TaskDepView,
  type TaskView,
} from '@t3-orchestra/shared';
import { useCallback, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { applyTask } from '@/api/cache';
import { api, errorMessage, isApiError } from '@/api/client';
import { keys } from '@/api/keys';
import { useConfirm } from '@/components/ui/confirm';
import { joinDeps } from '@/lib/stage';

// --- in-flight tracking (so any button for a task can show a spinner) ----------------------------
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
function setInFlight(key: string, on: boolean) {
  if (on) inFlight.add(key);
  else inFlight.delete(key);
  version++;
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Is `action` currently running for `taskId`? (Omit `action` to ask about any action.) */
export function useActionPending(taskId: string, action?: TaskAction): boolean {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  if (action) return inFlight.has(`${taskId}:${action}`);
  for (const k of inFlight) if (k.startsWith(`${taskId}:`)) return true;
  return false;
}

// --- optimistic stages ---------------------------------------------------------------------------
const OPTIMISTIC_STAGE: Partial<Record<TaskAction, Stage>> = {
  start: 'implementing',
  'move-to-ready': 'ready',
  'move-to-backlog': 'backlog',
  'mark-done': 'done',
  discard: 'discarded',
  resume: 'implementing',
  'retry-fresh': 'implementing',
  'request-changes': 'implementing',
  'send-message': 'implementing',
  'choose-design': 'implementing',
  'update-branch': 'implementing',
  'open-pr': 'implementing',
  'rerun-review': 'ai_review',
};

export interface RunOptions {
  /** Ask for confirmation first (mark-done, discard, approve). */
  confirm?: boolean;
  /** Board context, used for confirmation copy (merge strategy, base branch). */
  board?: BoardView;
  /** After a successful move, also PATCH this position (drag and drop). */
  position?: number;
  /** Skip the optimistic stage change. */
  noOptimistic?: boolean;
}

function cachedTask(qc: QueryClient, task: TaskView): TaskView | undefined {
  return qc.getQueryData<TaskView[]>(keys.tasks(task.boardId))?.find((t) => t.id === task.id);
}

/** Shows the expected result of `action` right away; returns that copy (null if nothing changes). */
async function showOptimistic(qc: QueryClient, task: TaskView, action: TaskAction, opts: RunOptions): Promise<TaskView | null> {
  const stage = opts.noOptimistic ? undefined : OPTIMISTIC_STAGE[action];
  if (!stage && opts.position === undefined) return null;
  await qc.cancelQueries({ queryKey: keys.tasks(task.boardId), exact: true });
  const next: TaskView = { ...task, ...(stage ? { stage, attention: null } : {}) };
  if (opts.position !== undefined) next.position = opts.position;
  if (stage === 'implementing') next.activeRun = null;
  next.column = columnFor(next);
  applyTask(qc, next);
  return next;
}

/** Sends the action (then the drop position) and applies the result; on failure rolls `optimistic` back and rethrows. */
async function send(
  qc: QueryClient,
  task: TaskView,
  action: TaskAction,
  body: TaskActionBody,
  opts: RunOptions,
  optimistic: TaskView | null,
): Promise<TaskView> {
  const flightKey = `${task.id}:${action}`;
  setInFlight(flightKey, true);
  try {
    let updated = await api.taskAction(task.id, action, body);
    if (opts.position !== undefined && updated.position !== opts.position) {
      try {
        updated = await api.patchTask(task.id, { position: opts.position });
      } catch {
        // Position is cosmetic; keep the server's order if the PATCH fails.
      }
    }
    applyTask(qc, updated, { refreshDetail: true });
    return updated;
  } catch (err) {
    // Roll back only if nothing newer (e.g. an SSE push) replaced the optimistic copy.
    if (optimistic && cachedTask(qc, task) === optimistic) applyTask(qc, task);
    // Some failures still change the task server-side (a merge conflict sets merge_conflict).
    if (isApiError(err, 'MERGE_CONFLICT')) void qc.invalidateQueries({ queryKey: keys.task(task.id), exact: true });
    throw err;
  } finally {
    setInFlight(flightKey, false);
  }
}

const COMMIT_REQUEST =
  'Please commit all outstanding changes on your branch so the worktree is clean (no uncommitted or untracked files), then end with the same t3orchestra-result block as before.';

export function useTaskActions() {
  const qc = useQueryClient();
  const confirm = useConfirm();

  const confirmAction = useCallback(
    async (task: TaskView, action: TaskAction, board?: BoardView): Promise<boolean> => {
      switch (action) {
        case 'mark-done':
          return confirm({
            title: `Mark #${task.number} done?`,
            description: 'Use this when the work is merged (or you merged it yourself). The branch and worktree are kept.',
            confirmLabel: 'Mark done',
          });
        case 'discard':
          return confirm({
            title: `Discard #${task.number}?`,
            description:
              'The task is hidden from the board. Its branch and worktree are left alone; clean them up in T3 if you no longer need them.',
            confirmLabel: 'Discard',
            variant: 'destructive',
          });
        case 'approve': {
          if (board?.mergeStrategy === 'local') {
            return confirm({
              title: `Merge #${task.number} into ${board.baseBranch}?`,
              description: (
                <span>
                  Runs{' '}
                  <code className="font-mono text-xs">
                    git merge --no-ff {task.branch ?? 'the task branch'}
                  </code>{' '}
                  in the project root. The root checkout must be on{' '}
                  <code className="font-mono text-xs">{board.baseBranch}</code> and clean.
                </span>
              ),
              confirmLabel: 'Approve & merge',
            });
          }
          return true;
        }
        case 'retry-fresh':
          return confirm({
            title: `Retry #${task.number} from scratch?`,
            description: 'Starts a new T3 thread on a fresh branch. The old branch and thread are kept.',
            confirmLabel: 'Retry fresh',
          });
        default:
          return true;
      }
    },
    [confirm],
  );

  const run = useCallback(
    async (
      task: TaskView,
      action: TaskAction,
      body: TaskActionBody = {},
      opts: RunOptions = {},
    ): Promise<TaskView | null> => {
      if (opts.confirm && !(await confirmAction(task, action, opts.board))) return null;

      const optimistic = await showOptimistic(qc, task, action, opts);
      try {
        return await send(qc, task, action, body, opts, optimistic);
      } catch (err) {
        if (isApiError(err, 'DEPS_NOT_DONE') && !body.force) {
          const details = err.details as { waitingOn?: TaskDepView[] } | undefined;
          const waitingOn = details?.waitingOn?.length ? details.waitingOn : task.waitingOn;
          const ok = await confirm({
            title: 'Dependencies are not done',
            description: `#${task.number} depends on ${joinDeps(waitingOn)}. Start anyway?`,
            confirmLabel: 'Start anyway',
          });
          if (ok) return run(task, action, { ...body, force: true }, { ...opts, confirm: false });
          return null;
        }
        showActionError(err, task, (a, b) => void run(task, a, b));
        return null;
      }
    },
    [qc, confirm, confirmAction],
  );

  /**
   * Runs `action` on several tasks (no confirmation): every card moves at once, the requests go one
   * at a time in the given order, and one toast lists whatever failed. Returns the updated tasks.
   */
  const runMany = useCallback(
    async (
      list: TaskView[],
      action: TaskAction,
      opts: { positions?: ReadonlyMap<string, number> } = {},
    ): Promise<TaskView[]> => {
      const optsFor = (t: TaskView): RunOptions => ({ position: opts.positions?.get(t.id) });
      const optimistic = new Map<string, TaskView | null>();
      for (const t of list) optimistic.set(t.id, await showOptimistic(qc, t, action, optsFor(t)));

      const updated: TaskView[] = [];
      const failed: string[] = [];
      for (const t of list) {
        try {
          updated.push(await send(qc, t, action, {}, optsFor(t), optimistic.get(t.id) ?? null));
        } catch (err) {
          failed.push(`#${t.number}: ${errorMessage(err)}`);
        }
      }
      if (failed.length > 0) {
        toast.error(
          failed.length === list.length ? `Could not update ${plural(list.length)}` : `${failed.length} of ${list.length} tasks were not updated`,
          { description: <span className="whitespace-pre-wrap">{failed.join('\n')}</span>, duration: 20_000, closeButton: true },
        );
      }
      return updated;
    },
    [qc],
  );

  return { run, runMany };
}

const plural = (n: number) => (n === 1 ? '1 task' : `${n} tasks`);

function showActionError(
  err: unknown,
  task: TaskView,
  retry: (action: TaskAction, body?: TaskActionBody) => void,
): void {
  const message = errorMessage(err);
  const description = <span className="whitespace-pre-wrap">{message}</span>;
  const long = { duration: 20_000, closeButton: true } as const;

  if (!isApiError(err)) {
    toast.error(`#${task.number}: action failed`, { description });
    return;
  }
  switch (err.code) {
    case 'DIRTY_ROOT':
      toast.error("Can't merge: the project root isn't ready", { description, ...long });
      break;
    case 'DIRTY_WORKTREE':
      toast.error(`#${task.number} has uncommitted changes`, {
        description,
        ...long,
        action: { label: 'Ask agent to commit', onClick: () => retry('send-message', { text: COMMIT_REQUEST }) },
      });
      break;
    case 'MERGE_CONFLICT':
      toast.error(`#${task.number} conflicts with the base branch`, {
        description,
        ...long,
        action: { label: 'Update branch', onClick: () => retry('update-branch') },
      });
      break;
    case 'T3_UNAVAILABLE':
      toast.error("T3 Code isn't running", { description, ...long });
      break;
    case 'ILLEGAL_TRANSITION':
      toast.error(`#${task.number}: not allowed in this stage`, { description });
      break;
    default:
      toast.error(`#${task.number}: ${message}`);
  }
}
