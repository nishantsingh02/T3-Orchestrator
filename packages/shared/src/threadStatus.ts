// Grouping of T3 thread statuses (spec §4.4).

export type ThreadStatusGroup = 'active' | 'attention' | 'finished_ok' | 'finished_bad' | 'unknown';

const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running']);
const BAD = new Set(['failed', 'interrupted', 'cancelled', 'rolled_back']);

export function threadStatusGroup(t: {
  status: string;
  pendingRequestCount?: number | null;
  runCount?: number | null;
}): ThreadStatusGroup {
  if (t.status === 'waiting' || (t.pendingRequestCount ?? 0) > 0) return 'attention';
  if (ACTIVE.has(t.status)) return 'active';
  if (t.status === 'completed') return 'finished_ok';
  // `idle` after at least one run counts as a normal finish. `runCount` is missing from
  // `thread list`, so callers pass it from `show`; unknown means "assume it ran".
  if (t.status === 'idle') return (t.runCount ?? 1) > 0 ? 'finished_ok' : 'unknown';
  if (BAD.has(t.status)) return 'finished_bad';
  return 'unknown';
}

export function isFinishedGroup(g: ThreadStatusGroup): boolean {
  return g === 'finished_ok' || g === 'finished_bad';
}

/** Parses the ordinal out of a T3 run id (`run:thread:<id>:ordinal:<n>`). */
export function runOrdinal(runId: string | null | undefined): number | null {
  if (!runId) return null;
  const m = /:ordinal:(\d+)$/.exec(runId);
  return m ? Number(m[1]) : null;
}
