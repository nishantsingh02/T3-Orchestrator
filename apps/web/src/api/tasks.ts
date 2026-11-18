import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateTaskBody, PatchTaskBody, TaskView } from '@t3-orchestra/shared';
import { toast } from 'sonner';
import { applyTask } from './cache';
import { api, errorMessage } from './client';
import { keys } from './keys';

/** Every task on a board, discarded included (the board filters client-side). */
export function useBoardTasks(boardId: string | undefined) {
  return useQuery({
    queryKey: keys.tasks(boardId ?? ''),
    queryFn: () => api.boardTasks(boardId as string),
    enabled: Boolean(boardId),
  });
}

export function useTaskDetail(taskId: string | undefined) {
  return useQuery({
    queryKey: keys.task(taskId ?? ''),
    queryFn: () => api.task(taskId as string),
    enabled: Boolean(taskId),
  });
}

export function useTaskDiff(taskId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.diff(taskId ?? '', 'full'),
    queryFn: () => api.taskDiff(taskId as string, 'full'),
    enabled: Boolean(taskId) && enabled,
    staleTime: 15_000,
    retry: false,
  });
}

export function useCreateTask(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskBody) => api.createTask(boardId, body),
    onSuccess: (task) => applyTask(qc, task),
  });
}

/** Optimistic list update for the simple scalar fields of a PATCH. */
function optimisticPatch(task: TaskView, patch: PatchTaskBody): TaskView {
  const { dependsOn: _deps, ...rest } = patch;
  return { ...task, ...rest };
}

export function usePatchTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ task, patch }: { task: TaskView; patch: PatchTaskBody; silent?: boolean }) =>
      api.patchTask(task.id, patch),
    onMutate: async ({ task, patch }) => {
      await qc.cancelQueries({ queryKey: keys.tasks(task.boardId), exact: true });
      const optimistic = optimisticPatch(task, patch);
      applyTask(qc, optimistic);
      return { optimistic, task };
    },
    onError: (err, { silent }, ctx) => {
      if (ctx) {
        // Roll back only if nothing newer (an SSE push) replaced the optimistic copy.
        const current = qc.getQueryData<TaskView[]>(keys.tasks(ctx.task.boardId))?.find((t) => t.id === ctx.task.id);
        if (current === ctx.optimistic) applyTask(qc, ctx.task);
      }
      if (!silent) toast.error(`Could not update #${ctx?.task.number ?? ''}`, { description: errorMessage(err) });
    },
    onSuccess: (task) => applyTask(qc, task, { refreshDetail: true }),
  });
}

export function useAddFollowUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, text }: { taskId: string; text: string }) => api.addFollowUp(taskId, text),
    onSuccess: (task) => {
      applyTask(qc, task);
      toast.success(`Added #${task.number} to Backlog`, { description: task.title });
    },
    onError: (err) => toast.error('Could not add the follow-up', { description: errorMessage(err) }),
  });
}
