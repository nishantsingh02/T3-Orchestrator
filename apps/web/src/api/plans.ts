import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatePlanBody, PlanFromSpecInput, PlanTask, PlanView, ProposalPatch, RefinePlanInput } from '@t3-orchestra/shared';
import { toast } from 'sonner';
import { applyPlan, applyPlanDetail, applyTask } from './cache';
import { api, errorMessage } from './client';
import { keys } from './keys';

export function useBoardPlans(boardId: string | undefined) {
  return useQuery({
    queryKey: keys.plans(boardId ?? ''),
    queryFn: () => api.boardPlans(boardId as string),
    enabled: Boolean(boardId),
  });
}

export function usePlan(planId: string | undefined) {
  return useQuery({
    queryKey: keys.plan(planId ?? ''),
    queryFn: () => api.plan(planId as string),
    enabled: Boolean(planId),
  });
}

export function useCreatePlan(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePlanBody) => api.createPlan(boardId, body),
    onSuccess: (plan) => applyPlan(qc, plan),
  });
}

function onPlanError(label: string) {
  return (err: unknown) => toast.error(label, { description: errorMessage(err) });
}

export function usePatchProposal(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, patch }: { key: string; patch: ProposalPatch }) => api.patchProposal(planId, key, patch),
    onSuccess: (plan) => applyPlanDetail(qc, plan),
    onError: onPlanError('Could not save the proposal'),
  });
}

export function useAddProposal(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (task: PlanTask) => api.addProposal(planId, task),
    onSuccess: (plan) => applyPlanDetail(qc, plan),
    onError: onPlanError('Could not add the task'),
  });
}

export function useDeleteProposal(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.deleteProposal(planId, key),
    onSuccess: (plan) => applyPlanDetail(qc, plan),
    onError: onPlanError('Could not delete the task'),
  });
}

export function useRefinePlan(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RefinePlanInput) => api.refinePlan(planId, body),
    onSuccess: (plan) => applyPlan(qc, plan),
    onError: onPlanError('Could not refine the plan'),
  });
}

export function useEditSpec(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spec: string) => api.editSpec(planId, spec),
    onSuccess: (plan) => applyPlanDetail(qc, plan),
    onError: onPlanError('Could not save the spec'),
  });
}

export function useRefineSpec(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RefinePlanInput) => api.refineSpec(planId, body),
    onSuccess: (plan) => applyPlan(qc, plan),
    onError: onPlanError('Could not send your answers'),
  });
}

export function usePlanFromSpec(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PlanFromSpecInput) => api.planFromSpec(planId, body),
    onSuccess: (plan) => applyPlan(qc, plan),
    onError: onPlanError('Could not start planning the tasks'),
  });
}

export function useAcceptPlan(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keysToAccept?: string[]) => api.acceptPlan(planId, keysToAccept),
    onSuccess: ({ plan, tasks }) => {
      applyPlan(qc, plan);
      for (const t of tasks) applyTask(qc, t);
      void qc.invalidateQueries({ queryKey: keys.tasks(plan.boardId) });
      void qc.invalidateQueries({ queryKey: keys.board(plan.boardId) });
    },
  });
}

export function useDiscardPlan(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.discardPlan(planId),
    onSuccess: (plan: PlanView) => applyPlan(qc, plan),
    onError: onPlanError('Could not discard the plan'),
  });
}

export function useRetryPlan(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.retryPlan(planId),
    onSuccess: (plan: PlanView) => applyPlan(qc, plan),
    onError: onPlanError('Could not retry the plan'),
  });
}
