// One EventSource('/api/stream') for the whole app. Pushes go straight into the query cache.
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AppSettings, BoardView, StreamEvents, TaskView } from '@t3-orchestra/shared';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router';
import { toast } from 'sonner';
import { applyBoard, applyMilestone, applyPlan, applyTask, cachedTaskLists, removeMilestone, removeTask } from './cache';
import { applyIdea, applyIdeaBatch, toastIdeas } from './ideas';
import { toastImport } from './imports';
import { applyMarketingSource, removeMarketingSource } from './marketing';
import { applyKnowledgeBuild, invalidateKnowledge } from './knowledge';
import { applySecurityAudit, applySecurityFinding, applySecurityScan } from './security';
import { applyInsightChat, applyInsightMessage, removeInsightChat, toastAnswer } from './insights';
import { keys } from './keys';
import { appendRunLog, applyProjectRun, toastRunChange } from './projectRuns';
import { playChime } from '@/lib/sound';

export type StreamStatus = 'connecting' | 'open' | 'reconnecting';

let status: StreamStatus = 'connecting';
const statusListeners = new Set<() => void>();
function setStatus(s: StreamStatus) {
  if (s === status) return;
  status = s;
  for (const l of statusListeners) l();
}

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(
    (l) => {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    () => status,
    () => status,
  );
}

/** Where a notification should take you, from whatever the cache knows. */
function notifyHref(qc: QueryClient, n: StreamEvents['notify']): string | null {
  const boards = qc.getQueryData<BoardView[]>(keys.boards);
  const slug =
    n.boardSlug ??
    boards?.find((b) => b.id === n.boardId)?.slug ??
    qc.getQueryData<BoardView>(keys.board(n.boardId))?.slug;
  if (!slug) return null;
  if (n.taskId || n.taskNumber) {
    let num = n.taskNumber ?? null;
    if (num === null && n.taskId) {
      for (const [, list] of cachedTaskLists(qc)) {
        const t = list.find((x: TaskView) => x.id === n.taskId);
        if (t) num = t.number;
      }
    }
    if (num !== null) return `/b/${slug}/t/${num}`;
  }
  if (n.planId) return `/b/${slug}/plans/${n.planId}`;
  return `/b/${slug}`;
}

function showNotify(qc: QueryClient, navigate: NavigateFunction, n: StreamEvents['notify']) {
  const settings = qc.getQueryData<AppSettings>(keys.settings);
  if (settings && settings.notifications[n.type] === false) return;

  const href = notifyHref(qc, n);
  const opts = {
    id: n.id,
    description: n.body || undefined,
    duration: 9000,
    action: href ? { label: 'Open', onClick: () => navigate(href) } : undefined,
  };
  switch (n.type) {
    case 'task_failed':
    case 't3_down':
      toast.error(n.title, opts);
      break;
    case 'task_attention':
    case 'plan_input':
      toast.warning(n.title, opts);
      break;
    default:
      toast.success(n.title, opts);
  }
  // The backend's desktop toast plays its own sound; chime in-app only when desktop toasts are off.
  if (settings?.notifications.sound && !settings.notifications.desktop) playChime();
}

function parse<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export function useEventStream(): void {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let connectedOnce = false;
    let hadError = false;
    let disposed = false;

    const on = <K extends keyof StreamEvents>(source: EventSource, name: K, fn: (data: StreamEvents[K]) => void) => {
      source.addEventListener(name, (ev) => {
        const data = parse<StreamEvents[K]>((ev as MessageEvent<string>).data);
        if (data) fn(data);
      });
    };

    const connect = () => {
      if (disposed) return;
      setStatus(connectedOnce ? 'reconnecting' : 'connecting');
      const source = new EventSource('/api/stream');
      es = source;

      source.onopen = () => {
        attempt = 0;
        setStatus('open');
        // No replay on the server: anything we missed while disconnected is refetched.
        if (connectedOnce || hadError) void qc.invalidateQueries();
        connectedOnce = true;
        hadError = false;
      };
      source.onerror = () => {
        if (disposed) return;
        hadError = true;
        setStatus('reconnecting');
        if (source.readyState === EventSource.CLOSED) {
          // The browser gave up (non-200 or wrong content type): retry ourselves with backoff.
          source.close();
          const delay = Math.min(10_000, 1000 * 2 ** attempt++);
          retryTimer = setTimeout(connect, delay);
        }
      };

      on(source, 'task', (task) => applyTask(qc, task));
      on(source, 'task_removed', (ev) => removeTask(qc, ev));
      on(source, 'milestone', (m) => applyMilestone(qc, m));
      on(source, 'milestone_removed', (ev) => removeMilestone(qc, ev));
      on(source, 'plan', (plan) => applyPlan(qc, plan));
      on(source, 'board', (board) => {
        toastImport(qc, navigateRef.current, board);
        applyBoard(qc, board);
      });
      on(source, 'health', (health) => qc.setQueryData(keys.health, health));
      on(source, 'settings', (s) => qc.setQueryData(keys.settings, s));
      on(source, 'notify', (n) => showNotify(qc, navigateRef.current, n));
      on(source, 'project_run', (run) => {
        applyProjectRun(qc, run);
        toastRunChange(qc, run);
      });
      on(source, 'project_run_log', (ev) => appendRunLog(qc, ev));
      on(source, 'insight_chat', (chat) => applyInsightChat(qc, chat));
      on(source, 'insight_chat_removed', (ev) => removeInsightChat(qc, ev));
      on(source, 'insight_message', (m) => {
        applyInsightMessage(qc, m);
        toastAnswer(qc, navigateRef.current, m);
      });
      on(source, 'idea', (idea) => applyIdea(qc, idea));
      on(source, 'idea_batch', (batch) => {
        toastIdeas(qc, navigateRef.current, batch);
        applyIdeaBatch(qc, batch);
      });
      on(source, 'marketing_source', (s) => applyMarketingSource(qc, s));
      on(source, 'marketing_source_removed', (ev) => removeMarketingSource(qc, ev));
      on(source, 'security_finding', (f) => applySecurityFinding(qc, f));
      on(source, 'security_audit', (a) => applySecurityAudit(qc, navigateRef.current, a));
      on(source, 'security_scan', (s) => applySecurityScan(qc, navigateRef.current, s));
      on(source, 'knowledge_build', (b) => applyKnowledgeBuild(qc, navigateRef.current, b));
      on(source, 'knowledge_changed', (ev) => invalidateKnowledge(qc, ev.boardId));
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      es?.close();
    };
  }, [qc]);
}
