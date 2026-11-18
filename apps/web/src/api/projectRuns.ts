// "Run project": the runs list, a run's output, and start/stop. SSE pushes land here too (stream.ts).
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { FixRunResponse, ProjectRunStatus, ProjectRunView, RunLogView, StartRunBody, StreamEvents } from '@t3-orchestra/shared';
import { toast } from 'sonner';
import { applyTask } from './cache';
import { api, errorMessage, isApiError, type RunTarget } from './client';
import { keys } from './keys';

const MAX_LOG_CHARS = 250_000;

export const sameTarget = (r: RunTarget, t: RunTarget) => r.boardId === t.boardId && r.taskId === t.taskId;

/** Every run the server knows about (one per board root or task worktree). */
export function useProjectRuns() {
  return useQuery({ queryKey: keys.projectRuns, queryFn: api.projectRuns, staleTime: Infinity });
}

/** The latest run of this board root or task worktree, live or ended. */
export function useTargetRun(target: RunTarget): ProjectRunView | null {
  const runs = useProjectRuns();
  return runs.data?.find((r) => sameTarget(r, target)) ?? null;
}

/** Detected ways to run the target (asked fresh each time the panel opens). */
export function useRunInfo(target: RunTarget, enabled: boolean) {
  return useQuery({
    queryKey: keys.runInfo(target.boardId, target.taskId),
    queryFn: () => api.runInfo(target),
    enabled,
    staleTime: 0,
    retry: false,
  });
}

export function useRunLog(runId: string | null) {
  return useQuery({
    queryKey: keys.projectRunLog(runId ?? ''),
    queryFn: () => api.projectRunLog(runId!),
    enabled: Boolean(runId),
    staleTime: Infinity,
  });
}

export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ target, body }: { target: RunTarget; body?: StartRunBody }) => api.startRun(target, body),
    onSuccess: (run) => applyProjectRun(qc, run),
    onError: (err) => {
      // "Couldn't tell how to run it" opens the command form in the panel instead.
      if (!isApiError(err, 'NOTHING_TO_RUN')) toast.error('Could not start the project', { description: errorMessage(err) });
    },
  });
}

export function useStopRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (run: ProjectRunView) => api.stopProjectRun(run.id),
    onSuccess: (run) => applyProjectRun(qc, run),
    onError: (err) => toast.error('Could not stop the project', { description: errorMessage(err) }),
  });
}

/** Opens the target's folder in VS Code on the machine T3 Orchestra runs on. */
export function useOpenInVsCode() {
  return useMutation({
    mutationFn: (target: RunTarget) => api.openInVsCode(target),
    // A cold VS Code takes a few seconds to show a window; say the click landed.
    onSuccess: ({ dir }) => toast('Opening in VS Code', { description: dir }),
    onError: (err) => toast.error('Could not open VS Code', { description: errorMessage(err) }),
  });
}

/** The board project's GitHub page (from its `origin` remote), or null when it isn't on GitHub. */
export function useBoardGithubUrl(boardId: string) {
  return useQuery({ queryKey: keys.boardGithub(boardId), queryFn: () => api.boardGithub(boardId), select: (r) => r.url, staleTime: 5 * 60_000, retry: false });
}

/** "Fix with AI": a new task for a board run, or the error sent to the task's own agent. */
export async function requestFix(qc: QueryClient, run: ProjectRunView, note?: string): Promise<FixRunResponse> {
  const r = await api.fixProjectRun(run.id, note ? { note } : {});
  applyProjectRun(qc, r.run);
  applyTask(qc, r.task);
  if (r.startError) {
    toast.warning(`Task #${r.task.number} was created but not started`, { description: r.startError, duration: 12_000 });
  } else if (r.created) {
    toast.success(`An agent is fixing it in #${r.task.number}`, { description: r.task.title });
  } else {
    toast.success(`Sent to #${r.task.number}'s agent`, { description: 'Run it again once the task is back in Human Review.' });
  }
  return r;
}

export function useFixRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ run, note }: { run: ProjectRunView; note?: string }) => requestFix(qc, run, note),
    onError: (err) => toast.error('Could not ask the AI to fix it', { description: errorMessage(err) }),
  });
}

/** One run per target: a newer run replaces the old one in the list. */
export function applyProjectRun(qc: QueryClient, run: ProjectRunView): void {
  qc.setQueryData<ProjectRunView[]>(keys.projectRuns, (old) => {
    if (!old) return old;
    const prev = old.find((r) => sameTarget(r, run));
    if (prev && prev.id !== run.id && prev.startedAt > run.startedAt) return old; // a late push for a replaced run
    return [...old.filter((r) => !sameTarget(r, run)), run];
  });
}

/** Appends pushed output to a cached log; a gap (missed pushes) refetches it. */
export function appendRunLog(qc: QueryClient, ev: StreamEvents['project_run_log']): void {
  let gap = false;
  qc.setQueryData<RunLogView>(keys.projectRunLog(ev.id), (old) => {
    if (!old) return old;
    if (ev.start > old.end) {
      gap = true;
      return old;
    }
    const overlap = old.end - ev.start;
    if (overlap >= ev.text.length) return old;
    let text = old.text + ev.text.slice(overlap);
    if (text.length > MAX_LOG_CHARS) text = text.slice(text.indexOf('\n', text.length - MAX_LOG_CHARS * 0.8) + 1);
    return { text, end: ev.start + ev.text.length };
  });
  if (gap) void qc.invalidateQueries({ queryKey: keys.projectRunLog(ev.id), exact: true });
}

// ---- toasts --------------------------------------------------------------------------

const seen = new Map<string, ProjectRunStatus>();
/** Targets whose run panel is open: no toast, the panel already shows it. */
export const openRunPanels = new Set<string>();
export const targetKey = (t: RunTarget) => `${t.boardId}:${t.taskId ?? ''}`;

/** Toasts when a run seen starting becomes ready or fails. */
export function toastRunChange(qc: QueryClient, run: ProjectRunView): void {
  const prev = seen.get(run.id);
  seen.set(run.id, run.status);
  if (!prev || prev === run.status || openRunPanels.has(targetKey(run))) return;
  if (run.status === 'ready' && run.url) {
    const url = run.url;
    toast.success(`${run.recipe.label} is running`, {
      description: url,
      duration: 12_000,
      action: { label: 'Open', onClick: () => window.open(url, '_blank', 'noopener') },
    });
  } else if (run.status === 'failed') {
    toast.error(`${run.recipe.label} stopped`, {
      description: run.error ?? undefined,
      duration: 15_000,
      action: {
        label: 'Fix with AI',
        onClick: () =>
          void requestFix(qc, run).catch((err) => toast.error('Could not ask the AI to fix it', { description: errorMessage(err) })),
      },
    });
  }
}
