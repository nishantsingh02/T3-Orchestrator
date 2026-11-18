// Ideas: queries, mutations and the cache updates SSE pushes go through.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  IDEA_CATEGORY_LABELS,
  isMarketingCategory,
  type AnyIdeaCategory,
  type BoardIdeasView,
  type BoardView,
  type IdeaBatchView,
  type IdeaView,
} from '@t3-orchestra/shared';
import type { NavigateFunction } from 'react-router';
import { toast } from 'sonner';
import { applyTask } from './cache';
import { api, errorMessage } from './client';
import { keys } from './keys';

/** Newest generation first; within one, the agent's order (best first). */
function sortIdeas(list: IdeaView[], batches: IdeaBatchView[]): IdeaView[] {
  const number = new Map(batches.map((b) => [b.id, b.number]));
  return list.slice().sort((a, b) => (number.get(b.batchId) ?? Infinity) - (number.get(a.batchId) ?? Infinity));
}

export function applyIdea(qc: QueryClient, idea: IdeaView): void {
  qc.setQueryData<BoardIdeasView>(keys.ideas(idea.boardId), (old) => {
    if (!old) return old;
    const rest = old.ideas.filter((i) => i.id !== idea.id);
    const at = old.ideas.findIndex((i) => i.id === idea.id);
    if (idea.status === 'dismissed') return { ...old, ideas: rest };
    // Keep a known idea in place; a new one goes to the end of its generation.
    const ideas = at === -1 ? [...rest, idea] : old.ideas.map((i) => (i.id === idea.id ? idea : i));
    return { ...old, ideas: sortIdeas(ideas, old.batches) };
  });
}

export function applyIdeaBatch(qc: QueryClient, batch: IdeaBatchView): void {
  qc.setQueryData<BoardIdeasView>(keys.ideas(batch.boardId), (old) => {
    if (!old) return old;
    const batches = [batch, ...old.batches.filter((b) => b.id !== batch.id)].sort((a, b) => b.number - a.number);
    return { batches, ideas: sortIdeas(old.ideas, batches) };
  });
}

export function boardSlug(qc: QueryClient, boardId: string): string | null {
  const fromList = qc.getQueryData<BoardView[]>(keys.boards)?.find((b) => b.id === boardId)?.slug;
  if (fromList) return fromList;
  for (const [, b] of qc.getQueriesData<BoardView>({ queryKey: keys.boardPrefix })) if (b?.id === boardId) return b.slug;
  return null;
}

/** Toast for a finished generation, unless its view (Ideas or Marketing) is on screen (it shows the result itself). */
export function toastIdeas(qc: QueryClient, navigate: NavigateFunction, batch: IdeaBatchView): void {
  if (batch.status !== 'done' && batch.status !== 'failed') return;
  const before = qc.getQueryData<BoardIdeasView>(keys.ideas(batch.boardId))?.batches.find((b) => b.id === batch.id);
  if (before?.status === batch.status) return;
  const marketing = isMarketingCategory(batch.category);
  if (window.location.pathname.endsWith(marketing ? '/marketing' : '/ideas')) return;
  const slug = boardSlug(qc, batch.boardId);
  const label = IDEA_CATEGORY_LABELS[batch.category];
  const [one, many] = marketing ? ['task', 'tasks'] : ['idea', 'ideas'];
  const target = marketing ? `/b/${slug}/marketing?section=${batch.category}` : `/b/${slug}/ideas?category=${batch.category}`;
  const opts = {
    id: `ideas:${batch.id}`,
    duration: 9000,
    action: slug ? { label: 'Open', onClick: () => navigate(target) } : undefined,
  };
  if (batch.status === 'failed') toast.error(`${label}: could not generate ${many}`, { ...opts, description: batch.error ?? undefined });
  else if (batch.ideaCount === 0) toast(`${label}: no new ${many}`, { ...opts, description: batch.summary ?? undefined });
  else toast.success(`${label}: ${batch.ideaCount} new ${batch.ideaCount === 1 ? one : many}`, opts);
}

export function useIdeas(boardId: string | undefined) {
  return useQuery({
    queryKey: keys.ideas(boardId ?? ''),
    queryFn: () => api.ideas(boardId as string),
    enabled: Boolean(boardId),
  });
}

export function useGenerateIdeas(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (category: AnyIdeaCategory) => api.generateIdeas(boardId, category),
    onSuccess: (batch) => applyIdeaBatch(qc, batch),
    onError: (err) => toast.error('Could not start the agent', { description: errorMessage(err) }),
  });
}

export function useAddIdea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (idea: IdeaView) => api.addIdea(idea.id),
    onSuccess: ({ idea, task }) => {
      applyIdea(qc, idea);
      applyTask(qc, task);
    },
    onError: (err) => toast.error('Could not add the idea to the board', { description: errorMessage(err) }),
  });
}

export function useDismissIdea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idea, undo }: { idea: IdeaView; undo: boolean }) => api.dismissIdea(idea.id, undo),
    onMutate: ({ idea, undo }) => applyIdea(qc, { ...idea, status: undo ? 'new' : 'dismissed' }),
    onSuccess: (idea, { undo }) => {
      applyIdea(qc, idea);
      // A restored idea was re-added at the end of its generation; the server has its real place.
      if (undo) void qc.invalidateQueries({ queryKey: keys.ideas(idea.boardId), exact: true });
    },
    onError: (err, { idea }) => {
      applyIdea(qc, idea);
      toast.error('Could not dismiss the idea', { description: errorMessage(err) });
    },
  });
}

/** Marks a marketing `do` task done (or open again with `undo`), optimistically. */
export function useMarkIdeaDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idea, undo }: { idea: IdeaView; undo: boolean }) => api.markIdeaDone(idea.id, undo),
    onMutate: ({ idea, undo }) => applyIdea(qc, { ...idea, status: undo ? 'new' : 'done' }),
    onSuccess: (idea) => applyIdea(qc, idea),
    onError: (err, { idea }) => {
      applyIdea(qc, idea);
      toast.error('Could not update the task', { description: errorMessage(err) });
    },
  });
}
