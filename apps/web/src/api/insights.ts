// Insights chats: queries, mutations and the cache updates SSE pushes go through.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { BoardView, InsightChatDetailView, InsightChatView, InsightMessageView } from '@t3-orchestra/shared';
import type { NavigateFunction } from 'react-router';
import { toast } from 'sonner';
import { api, errorMessage, isApiError } from './client';
import { keys } from './keys';

const byRecent = (a: InsightChatView, b: InsightChatView) => b.updatedAt.localeCompare(a.updatedAt);

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function applyInsightChat(qc: QueryClient, chat: InsightChatView): void {
  qc.setQueryData<InsightChatView[]>(keys.insights(chat.boardId), (old) => old && upsert(old, chat).sort(byRecent));
  qc.setQueryData<InsightChatDetailView>(keys.insight(chat.id), (old) => old && { ...old, ...chat });
}

export function applyInsightMessage(qc: QueryClient, m: InsightMessageView): void {
  qc.setQueryData<InsightChatDetailView>(
    keys.insight(m.chatId),
    (old) => old && { ...old, messages: upsert(old.messages, m).sort((a, b) => a.seq - b.seq) },
  );
}

function applyInsightDetail(qc: QueryClient, chat: InsightChatDetailView): void {
  qc.setQueryData(keys.insight(chat.id), chat);
  const { messages: _messages, ...summary } = chat;
  applyInsightChat(qc, summary);
}

export function removeInsightChat(qc: QueryClient, ev: { id: string; boardId: string }): void {
  qc.setQueryData<InsightChatView[]>(keys.insights(ev.boardId), (old) => old?.filter((c) => c.id !== ev.id));
  qc.removeQueries({ queryKey: keys.insight(ev.id), exact: true });
}

function boardSlug(qc: QueryClient, boardId: string): string | null {
  const fromList = qc.getQueryData<BoardView[]>(keys.boards)?.find((b) => b.id === boardId)?.slug;
  if (fromList) return fromList;
  for (const [, b] of qc.getQueriesData<BoardView>({ queryKey: keys.boardPrefix })) if (b?.id === boardId) return b.slug;
  return null;
}

/** Toast for a finished answer, unless that chat is on screen. */
export function toastAnswer(qc: QueryClient, navigate: NavigateFunction, m: InsightMessageView): void {
  if (m.role !== 'assistant' || (m.status !== 'done' && m.status !== 'failed')) return;
  const onScreen =
    window.location.pathname.endsWith('/insights') && new URLSearchParams(window.location.search).get('chat') === m.chatId;
  if (onScreen) return;
  const slug = boardSlug(qc, m.boardId);
  const chat = qc.getQueryData<InsightChatView[]>(keys.insights(m.boardId))?.find((c) => c.id === m.chatId);
  const opts = {
    id: `insight:${m.id}`,
    description: chat?.title,
    duration: 9000,
    action: slug ? { label: 'Open', onClick: () => navigate(`/b/${slug}/insights?chat=${m.chatId}`) } : undefined,
  };
  if (m.status === 'done') toast.success('Insights answer ready', opts);
  else toast.error('Insights: the agent could not answer', opts);
}

export function useInsightChats(boardId: string | undefined) {
  return useQuery({
    queryKey: keys.insights(boardId ?? ''),
    queryFn: () => api.insightChats(boardId as string),
    enabled: Boolean(boardId),
  });
}

export function useInsightChat(chatId: string | null) {
  return useQuery({
    queryKey: keys.insight(chatId ?? ''),
    queryFn: () => api.insightChat(chatId as string),
    enabled: Boolean(chatId),
    retry: (n, err) => !(isApiError(err) && err.status === 404) && n < 2,
  });
}

export function useCreateInsightChat(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.createInsightChat(boardId, text),
    onSuccess: (chat) => applyInsightDetail(qc, chat),
    onError: (err) => toast.error('Could not ask the agent', { description: errorMessage(err) }),
  });
}

export function useSendInsightMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, text }: { chatId: string; text: string }) => api.sendInsightMessage(chatId, text),
    onSuccess: (chat) => applyInsightDetail(qc, chat),
    onError: (err) => toast.error('Could not ask the agent', { description: errorMessage(err) }),
  });
}

export function useRenameInsightChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chat, title }: { chat: InsightChatView; title: string }) => api.renameInsightChat(chat.id, title),
    onMutate: ({ chat, title }) => applyInsightChat(qc, { ...chat, title }),
    onSuccess: (chat) => applyInsightChat(qc, chat),
    onError: (err, { chat }) => {
      applyInsightChat(qc, chat);
      toast.error('Could not rename the chat', { description: errorMessage(err) });
    },
  });
}

export function useDeleteInsightChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chat: InsightChatView) => api.deleteInsightChat(chat.id),
    onSuccess: (_r, chat) => removeInsightChat(qc, chat),
    onError: (err) => toast.error('Could not delete the chat', { description: errorMessage(err) }),
  });
}
