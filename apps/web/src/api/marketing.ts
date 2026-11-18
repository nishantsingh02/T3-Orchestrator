// Marketing metrics: queries, mutations and the cache updates SSE pushes go through.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { BoardMarketingView, CreateMarketingSourceBody, MarketingSourceView, PatchMarketingSourceBody } from '@t3-orchestra/shared';
import { toast } from 'sonner';
import { api, errorMessage } from './client';
import { keys } from './keys';

export function applyMarketingSource(qc: QueryClient, source: MarketingSourceView): void {
  qc.setQueryData<BoardMarketingView>(keys.marketing(source.boardId), (old) => {
    if (!old) return old;
    const at = old.sources.findIndex((s) => s.id === source.id);
    const sources = at === -1 ? [...old.sources, source] : old.sources.map((s) => (s.id === source.id ? source : s));
    // A connected suggestion is no longer one.
    const suggestions = old.suggestions.filter(
      (g) => !(g.kind === source.kind && Object.entries(g.config).every(([k, v]) => source.config[k]?.toLowerCase() === v.toLowerCase())),
    );
    return { sources, suggestions };
  });
}

export function removeMarketingSource(qc: QueryClient, ev: { id: string; boardId: string }): void {
  qc.setQueryData<BoardMarketingView>(keys.marketing(ev.boardId), (old) => (old ? { ...old, sources: old.sources.filter((s) => s.id !== ev.id) } : old));
  // The removed source may be suggested again.
  void qc.invalidateQueries({ queryKey: keys.marketing(ev.boardId), exact: true });
}

export function useMarketing(boardId: string | undefined) {
  return useQuery({
    queryKey: keys.marketing(boardId ?? ''),
    queryFn: () => api.marketing(boardId as string),
    enabled: Boolean(boardId),
  });
}

/** Connect a source. Errors are left to the caller (the form shows them). */
export function useAddSource(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMarketingSourceBody) => api.addMarketingSource(boardId, body),
    onSuccess: (source) => applyMarketingSource(qc, source),
  });
}

export function usePatchSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchMarketingSourceBody }) => api.patchMarketingSource(id, body),
    onSuccess: (source) => applyMarketingSource(qc, source),
  });
}

export function useRemoveSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (source: MarketingSourceView) => api.removeMarketingSource(source.id),
    onSuccess: (_res, source) => removeMarketingSource(qc, source),
    onError: (err) => toast.error('Could not remove the source', { description: errorMessage(err) }),
  });
}

export function useRefreshSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (source: MarketingSourceView) => api.refreshMarketingSource(source.id),
    onSuccess: (source) => applyMarketingSource(qc, source),
    onError: (err) => toast.error('Could not refresh', { description: errorMessage(err) }),
  });
}

export function useRefreshAll(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshMarketing(boardId),
    onSuccess: (sources) => {
      for (const s of sources) applyMarketingSource(qc, s);
      const failed = sources.filter((s) => s.status === 'error');
      if (failed.length) toast.error(`${failed.length} of ${sources.length} sources could not be read`, { description: failed.map((s) => s.name).join(', ') });
    },
    onError: (err) => toast.error('Could not refresh', { description: errorMessage(err) }),
  });
}

export function useLogValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ source, value }: { source: MarketingSourceView; value: number }) => api.logMetricValue(source.id, value),
    onSuccess: (source) => applyMarketingSource(qc, source),
  });
}
