import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateMilestoneBody, MilestoneView, PatchMilestoneBody, SuggestionRef } from '@t3-orchestra/shared';
import { toast } from 'sonner';
import { applyMilestone, applyTask, removeMilestone } from './cache';
import { api, errorMessage } from './client';
import { keys } from './keys';

export function useMilestones(boardId: string | undefined) {
  return useQuery({
    queryKey: keys.milestones(boardId ?? ''),
    queryFn: () => api.milestones(boardId as string),
    enabled: Boolean(boardId),
  });
}

export function useCreateMilestone(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMilestoneBody) => api.createMilestone(boardId, body),
    onSuccess: (m) => applyMilestone(qc, m),
    onError: (err) => toast.error('Could not add the milestone', { description: errorMessage(err) }),
  });
}

export function usePatchMilestone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ milestone, patch }: { milestone: MilestoneView; patch: PatchMilestoneBody }) =>
      api.patchMilestone(milestone.id, patch),
    onMutate: ({ milestone, patch }) => applyMilestone(qc, { ...milestone, ...patch }),
    onSuccess: (m) => applyMilestone(qc, m),
    onError: (err, { milestone }) => {
      applyMilestone(qc, milestone);
      toast.error('Could not update the milestone', { description: errorMessage(err) });
    },
  });
}

export function useDeleteMilestone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (m: MilestoneView) => api.deleteMilestone(m.id),
    onSuccess: (_r, m) => removeMilestone(qc, m),
    onError: (err) => toast.error('Could not delete the milestone', { description: errorMessage(err) }),
  });
}

/** Agent follow-up suggestions not yet added or dismissed. The Roadmap refetches it when tasks change. */
export function useSuggestions(boardId: string | undefined) {
  return useQuery({
    queryKey: keys.suggestions(boardId ?? ''),
    queryFn: () => api.suggestions(boardId as string),
    enabled: Boolean(boardId),
    placeholderData: (prev) => prev,
  });
}

export function useAddSuggestions(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { items: SuggestionRef[]; milestoneId: string | null }) => api.addSuggestions(boardId, body),
    onSuccess: (tasks) => {
      for (const t of tasks) applyTask(qc, t);
      void qc.invalidateQueries({ queryKey: keys.suggestions(boardId), exact: true });
    },
    onError: (err) => toast.error('Could not add the suggestions', { description: errorMessage(err) }),
  });
}

export function useDismissSuggestions(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { items: SuggestionRef[]; undo: boolean }) => api.dismissSuggestions(boardId, body),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.suggestions(boardId), exact: true }),
    onError: (err) => toast.error('Could not update the suggestions', { description: errorMessage(err) }),
  });
}
