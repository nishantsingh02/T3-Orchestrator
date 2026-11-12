// Board statistics for the Overview: agent time per run kind, and time spent waiting for the user.
import { median, RUN_KINDS, type BoardStatsView, type RunKind, type WaitStats } from '@t3-orchestra/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.ts';
import { events, runs } from './schema.ts';

const FAILED_RUN: ReadonlySet<string> = new Set(['failed', 'interrupted', 'cancelled', 'lost']);

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

function waitStats(spans: number[], open: number): WaitStats {
  return { count: spans.length, totalMs: sum(spans), medianMs: median(spans), open };
}

interface StageChange {
  event?: string;
  from?: string | null;
  to?: string;
  reason?: string | null;
}

export function boardStats(db: Db, boardId: string): BoardStatsView {
  const runRows = db
    .select({ kind: runs.kind, status: runs.status, startedAt: runs.startedAt, finishedAt: runs.finishedAt })
    .from(runs)
    .where(eq(runs.boardId, boardId))
    .all();
  const byKind = new Map<RunKind, { runs: number; failed: number; spans: number[] }>();
  for (const r of runRows) {
    const k = byKind.get(r.kind) ?? { runs: 0, failed: 0, spans: [] };
    k.runs++;
    if (FAILED_RUN.has(r.status)) k.failed++;
    const span = r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : Number.NaN;
    if (span >= 0) k.spans.push(span);
    byKind.set(r.kind, k);
  }

  const evRows = db
    .select({ taskId: events.taskId, type: events.type, payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(eq(events.boardId, boardId), inArray(events.type, ['stage_changed', 'attention_set', 'attention_cleared'])))
    .orderBy(asc(events.id))
    .all();
  const answerSince = new Map<string, number>();
  const reviewSince = new Map<string, number>();
  const answerSpans: number[] = [];
  const reviewSpans: number[] = [];
  let mergeConflicts = 0;
  const endAnswer = (taskId: string, at: number) => {
    const s = answerSince.get(taskId);
    if (s === undefined) return;
    answerSpans.push(at - s);
    answerSince.delete(taskId);
  };
  for (const e of evRows) {
    if (!e.taskId) continue; // plan threads
    const at = Date.parse(e.createdAt);
    if (e.type === 'attention_set') {
      if (!answerSince.has(e.taskId)) answerSince.set(e.taskId, at);
      continue;
    }
    if (e.type === 'attention_cleared') {
      endAnswer(e.taskId, at);
      continue;
    }
    const p = e.payload as StageChange;
    if (p.reason === 'merge_conflict') mergeConflicts++;
    // A stage change clears attention without an attention_cleared event (transitions.ts).
    if (p.from !== p.to) endAnswer(e.taskId, at);
    if (p.to === 'human_review') {
      if (!reviewSince.has(e.taskId)) reviewSince.set(e.taskId, at);
    } else if (reviewSince.has(e.taskId)) {
      const s = reviewSince.get(e.taskId)!;
      reviewSince.delete(e.taskId);
      if (p.event !== 'auto.approve') reviewSpans.push(at - s);
    }
  }

  return {
    runs: RUN_KINDS.filter((k) => byKind.has(k)).map((kind) => {
      const k = byKind.get(kind)!;
      return { kind, runs: k.runs, failed: k.failed, totalMs: sum(k.spans), medianMs: median(k.spans) };
    }),
    answerWait: waitStats(answerSpans, answerSince.size),
    reviewWait: waitStats(reviewSpans, reviewSince.size),
    mergeConflicts,
  };
}
