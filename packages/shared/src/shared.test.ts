import { describe, expect, it } from 'vitest';
import {
  boardOverview,
  columnFor,
  computeWaves,
  holdReason,
  localDay,
  median,
  findCycle,
  PlanResult,
  pathsOverlap,
  overlapsActive,
  overlapPaths,
  pipelineFor,
  resolveTransition,
  STAGES,
  threadStatusGroup,
  runOrdinal,
  unknownDeps,
  wouldCreateCycle,
  type Stage,
  type TaskEvent,
  type TaskView,
} from './index.ts';

describe('columnFor', () => {
  it('maps every stage to its column', () => {
    const expected: Record<Stage, string> = {
      backlog: 'backlog',
      ready: 'ready',
      implementing: 'running',
      ai_review: 'ai_review',
      human_review: 'human_review',
      done: 'done',
      failed: 'failed',
      discarded: 'hidden',
    };
    for (const stage of STAGES) expect(columnFor({ stage, attention: null })).toBe(expected[stage]);
  });

  it('attention overrides stage columns but not discarded', () => {
    expect(columnFor({ stage: 'implementing', attention: 'waiting' })).toBe('needs_input');
    expect(columnFor({ stage: 'ai_review', attention: 'question' })).toBe('needs_input');
    expect(columnFor({ stage: 'discarded', attention: 'waiting' })).toBe('hidden');
  });
});

describe('transition table (spec §6.3)', () => {
  // [event, allowed from, to, reason]
  const rows: Array<[TaskEvent, Stage[], Stage, string | null]> = [
    [{ type: 'user.move_to_ready' }, ['backlog'], 'ready', null],
    [{ type: 'user.move_to_backlog' }, ['ready', 'failed'], 'backlog', null],
    [{ type: 'user.start' }, ['backlog', 'ready'], 'implementing', null],
    [{ type: 'scheduler.start' }, ['backlog', 'ready'], 'implementing', null],
    [{ type: 'run.done', skipReview: false }, ['implementing'], 'ai_review', null],
    [{ type: 'run.done', skipReview: true }, ['implementing'], 'human_review', 'ai_review_skipped'],
    [{ type: 'run.done', skipReview: true, prRun: true }, ['implementing'], 'human_review', 'pr_opened'],
    [{ type: 'run.blocked' }, ['implementing'], 'failed', 'agent_blocked'],
    [{ type: 'run.failed', status: 'failed' }, ['implementing'], 'failed', 'run_failed'],
    [{ type: 'run.failed', status: 'interrupted' }, ['implementing'], 'failed', 'run_interrupted'],
    [{ type: 'run.failed', status: 'cancelled' }, ['implementing'], 'failed', 'run_cancelled'],
    [{ type: 'run.failed', status: 'rolled_back' }, ['implementing'], 'failed', 'run_failed'],
    [{ type: 'run.start_failed' }, ['implementing'], 'failed', 'start_failed'],
    [{ type: 'review.pass' }, ['ai_review'], 'human_review', 'ai_passed'],
    [{ type: 'review.changes', roundsLeft: true }, ['ai_review'], 'implementing', null],
    [{ type: 'review.changes', roundsLeft: false }, ['ai_review'], 'human_review', 'ai_unresolved'],
    [{ type: 'review.failed' }, ['ai_review'], 'human_review', 'review_failed'],
    [{ type: 'user.rerun_review' }, ['human_review'], 'ai_review', null],
    [{ type: 'user.request_changes' }, ['human_review'], 'implementing', null],
    [{ type: 'user.send_message' }, ['human_review', 'failed'], 'implementing', null],
    [{ type: 'user.approve', outcome: 'merged' }, ['human_review'], 'done', null],
    [{ type: 'user.approve', outcome: 'manual' }, ['human_review'], 'done', null],
    [{ type: 'user.approve', outcome: 'conflict' }, ['human_review'], 'human_review', 'merge_conflict'],
    [{ type: 'auto.approve', outcome: 'merged' }, ['human_review'], 'done', 'auto_approved'],
    [{ type: 'auto.approve', outcome: 'manual' }, ['human_review'], 'done', 'auto_approved'],
    [{ type: 'auto.approve', outcome: 'conflict' }, ['human_review'], 'human_review', 'merge_conflict'],
    [{ type: 'user.update_branch' }, ['human_review'], 'implementing', null],
    [{ type: 'user.open_pr' }, ['human_review'], 'implementing', null],
    [{ type: 'user.mark_done' }, ['human_review'], 'done', null],
    [{ type: 'pr.merged' }, ['human_review'], 'done', null],
    [{ type: 'user.resume' }, ['failed'], 'implementing', null],
    [{ type: 'user.retry_fresh' }, ['failed'], 'implementing', null],
    [{ type: 'user.discard' }, ['backlog', 'ready', 'human_review', 'done', 'failed'], 'discarded', null],
    [{ type: 'thread.missing' }, ['implementing', 'ai_review'], 'failed', 'thread_missing'],
  ];

  for (const [event, from, to, reason] of rows) {
    const label = `${event.type}${'roundsLeft' in event ? `(${event.roundsLeft})` : ''}${'outcome' in event ? `(${event.outcome})` : ''}${'status' in event ? `(${event.status})` : ''}${'skipReview' in event ? `(skip=${event.skipReview}${event.prRun ? ',pr' : ''})` : ''}`;
    it(`${label}: allowed from ${from.join('/')}`, () => {
      for (const stage of from) expect(resolveTransition(stage, event)).toEqual({ to, reason });
    });
    it(`${label}: refused from every other stage`, () => {
      for (const stage of STAGES.filter((s) => !from.includes(s))) expect(resolveTransition(stage, event)).toBeNull();
    });
  }

  it('cannot discard a task with an active run', () => {
    expect(resolveTransition('implementing', { type: 'user.discard' })).toBeNull();
    expect(resolveTransition('ai_review', { type: 'user.discard' })).toBeNull();
  });
});

describe('dependency graph', () => {
  const n = (key: string, ...dependsOn: string[]) => ({ key, dependsOn });

  it('finds cycles and returns the path', () => {
    expect(findCycle([n('T1'), n('T2', 'T1'), n('T3', 'T2')])).toBeNull();
    const c = findCycle([n('T1', 'T3'), n('T2', 'T1'), n('T3', 'T2')]);
    expect(c?.[0]).toBe(c?.at(-1));
    expect(c).toHaveLength(4);
    expect(findCycle([n('T1', 'T1')])).toEqual(['T1', 'T1']);
  });

  it('reports unknown deps', () => {
    expect(unknownDeps([n('T1', 'T9'), n('T2', 'T1')])).toEqual([['T1', 'T9']]);
  });

  it('computes waves by topological depth', () => {
    const { waves, cyclic } = computeWaves([n('T1'), n('T2', 'T1'), n('T3', 'T1'), n('T4', 'T2', 'T3'), n('T5')]);
    expect(waves).toEqual([['T1', 'T5'], ['T2', 'T3'], ['T4']]);
    expect(cyclic).toEqual([]);
    expect(computeWaves([n('A', 'B'), n('B', 'A'), n('C')]).cyclic.sort()).toEqual(['A', 'B']);
  });

  it('wouldCreateCycle', () => {
    const g = [n('T1'), n('T2', 'T1')];
    expect(wouldCreateCycle(g, 'T1', 'T2')).toBe(true);
    expect(wouldCreateCycle(g, 'T2', 'T1')).toBe(false);
  });
});

describe('PlanResult schema', () => {
  const task = (key: string, dependsOn: string[] = []) => ({
    key,
    title: `Task ${key}`,
    description: 'd',
    acceptanceCriteria: ['works'],
    complexity: 'small',
    category: 'feature',
    dependsOn,
  });

  it('accepts a valid plan and applies defaults', () => {
    const r = PlanResult.parse({ summary: 's', tasks: [task('T1'), task('T2', ['T1'])] });
    expect(r.tasks[0]!.priority).toBe('medium');
    expect(r.tasks[0]!.touches).toEqual([]);
    expect(r.assumptions).toEqual([]);
  });

  it('rejects unknown deps, cycles and duplicate keys', () => {
    expect(PlanResult.safeParse({ summary: 's', tasks: [task('T1', ['T5'])] }).success).toBe(false);
    expect(PlanResult.safeParse({ summary: 's', tasks: [task('T1', ['T2']), task('T2', ['T1'])] }).success).toBe(false);
    expect(PlanResult.safeParse({ summary: 's', tasks: [task('T1'), task('T1')] }).success).toBe(false);
  });

  it('rejects more than 40 tasks', () => {
    const tasks = Array.from({ length: 41 }, (_, i) => task(`T${i + 1}`));
    expect(PlanResult.safeParse({ summary: 's', tasks }).success).toBe(false);
  });
});

describe('overlap (spec §7)', () => {
  it('treats path prefixes as overlapping', () => {
    expect(pathsOverlap('src/auth/', 'src/auth/login.ts')).toBe(true);
    expect(pathsOverlap('src/auth', 'src/auth/login.ts')).toBe(true);
    expect(pathsOverlap('src/auth/login.ts', 'src/auth/login.ts')).toBe(true);
    expect(pathsOverlap('./src\\auth', 'src/auth/x')).toBe(true);
  });

  it('does not match sibling names that share a prefix string', () => {
    expect(pathsOverlap('src/auth', 'src/authz/x.ts')).toBe(false);
    expect(pathsOverlap('src/a.ts', 'src/b.ts')).toBe(false);
  });

  it('empty touches never overlap', () => {
    expect(overlapsActive([], [['src/']])).toBe(false);
    expect(overlapsActive(['src/'], [[]])).toBe(false);
    expect(overlapsActive(['src/ui/'], [['src/db/'], ['src/ui/button.tsx']])).toBe(true);
  });

  it('names the broader side of each overlapping pair', () => {
    expect(overlapPaths(['backend/tests/', 'api/items.py'], ['backend/tests/fixtures/tag/', 'backend/tests/'])).toEqual([
      'backend/tests/',
    ]);
    expect(overlapPaths(['./src\\ui/button.tsx', 'docs/'], ['src/ui'])).toEqual(['src/ui']);
    expect(overlapPaths(['src/a.ts'], ['src/b.ts'])).toEqual([]);
  });
});

describe('thread status groups (spec §4.4)', () => {
  it('groups statuses', () => {
    expect(threadStatusGroup({ status: 'running' })).toBe('active');
    expect(threadStatusGroup({ status: 'preparing' })).toBe('active');
    expect(threadStatusGroup({ status: 'waiting' })).toBe('attention');
    expect(threadStatusGroup({ status: 'running', pendingRequestCount: 1 })).toBe('attention');
    expect(threadStatusGroup({ status: 'completed' })).toBe('finished_ok');
    expect(threadStatusGroup({ status: 'idle', runCount: 2 })).toBe('finished_ok');
    expect(threadStatusGroup({ status: 'idle', runCount: 0 })).toBe('unknown');
    expect(threadStatusGroup({ status: 'interrupted' })).toBe('finished_bad');
    expect(threadStatusGroup({ status: 'rolled_back' })).toBe('finished_bad');
  });

  it('parses run ordinals, including url-encoded thread ids', () => {
    expect(runOrdinal('run:thread:mcp%3Aabc:ordinal:12')).toBe(12);
    expect(runOrdinal(null)).toBeNull();
  });
});

describe('pipeline strip', () => {
  it('marks steps', () => {
    expect(pipelineFor({ stage: 'ready', reviewRound: 0 })).toEqual({ plan: 'done', build: 'todo', ai_review: 'todo', human: 'todo', done: 'todo' });
    expect(pipelineFor({ stage: 'implementing', reviewRound: 0 }).build).toBe('current');
    expect(pipelineFor({ stage: 'ai_review', reviewRound: 1 })).toMatchObject({ build: 'done', ai_review: 'current' });
    expect(pipelineFor({ stage: 'done', reviewRound: 1 })).toEqual({ plan: 'done', build: 'done', ai_review: 'done', human: 'done', done: 'done' });
  });
});

const DAY = 86_400_000;
let nextNumber = 1;
function tv(p: Partial<TaskView> = {}): TaskView {
  const n = p.number ?? nextNumber++;
  return {
    id: `t${n}`, boardId: 'b', number: n, planId: null, planKey: null, followUpOf: null, followUpText: null, milestoneId: null,
    title: `Task ${n}`, description: '', acceptanceCriteria: [], category: 'feature', complexity: 'medium',
    priority: 'medium', touches: [], position: n, stage: 'ready', stageReason: null, attention: null, column: 'ready',
    threadId: null, threadLink: null, branch: null, worktreePath: null, fixRound: 0, reviewRound: 0, reviewScore: null,
    reviewScoreReason: null, skipAiReview: false, runNext: false, providerOverride: null, modelOverride: null, lastSummary: null,
    lastMessage: null, resultMissing: false, prUrl: null, lastThreadStatus: null, lastActivityAt: null, startedAt: null,
    completedAt: null, activitySinceReview: false, deps: [], blockedBy: [], waitingOn: [], activeRun: null,
    findings: { open: {}, total: 0 }, design: null, diffStat: null, quietMinutes: null,
    createdAt: new Date(2026, 10, 5, 9).toISOString(), updatedAt: new Date(2026, 10, 5, 9).toISOString(),
    ...p,
  };
}
const dep = (t: TaskView) => ({ id: t.id, number: t.number, title: t.title, stage: t.stage });
const gate = { autoRun: true, maxParallel: 2, avoidOverlap: true };

describe('holdReason (mirrors the scheduler, spec §7)', () => {
  it('checks dependencies, auto-run, pause, slots, then overlap', () => {
    const d = tv({ stage: 'implementing' });
    expect(holdReason(tv({ waitingOn: [dep(d)] }), gate, [], false)).toMatchObject({ kind: 'waiting' });
    expect(holdReason(tv({ blockedBy: [dep(d)], waitingOn: [dep(d)] }), gate, [], false)).toMatchObject({ kind: 'blocked' });
    expect(holdReason(tv({ stage: 'backlog' }), gate, [], false)).toEqual({ kind: 'backlog' });
    expect(holdReason(tv(), { ...gate, autoRun: false }, [], false)).toEqual({ kind: 'auto_run_off' });
    expect(holdReason(tv(), gate, [], true)).toEqual({ kind: 'paused' });
    const a = tv({ stage: 'implementing', touches: ['src/api/'] });
    expect(holdReason(tv(), gate, [a, tv({ stage: 'ai_review' })], false)).toEqual({ kind: 'no_slot', active: 2, max: 2 });
    expect(holdReason(tv({ touches: ['src/api/x.ts'] }), gate, [a], false)).toEqual({ kind: 'overlap', tasks: [a.number], paths: ['src/api/'] });
    expect(holdReason(tv({ touches: ['src/api/x.ts'] }), { ...gate, avoidOverlap: false }, [a], false)).toEqual({ kind: 'ready' });
    // "Run next" skips the overlap gate but still waits for a slot.
    expect(holdReason(tv({ touches: ['src/api/x.ts'], runNext: true }), gate, [a], false)).toEqual({ kind: 'ready' });
    expect(holdReason(tv({ runNext: true }), gate, [a, tv({ stage: 'ai_review' })], false)).toMatchObject({ kind: 'no_slot' });
    expect(holdReason(tv({ stage: 'done' }), gate, [], false)).toBeNull();
  });
});

describe('boardOverview', () => {
  const now = new Date(2026, 10, 7, 12).getTime();
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

  it('counts columns, scope per plan with follow-ups, and skips discarded tasks', () => {
    const p1 = tv({ planId: 'P1', stage: 'done', completedAt: at(1) });
    const p2 = tv({ planId: 'P1', stage: 'human_review' });
    const fu = tv({ followUpOf: p1.id, stage: 'ready' });
    const fuOfFu = tv({ followUpOf: fu.id, stage: 'done', completedAt: at(0) });
    const manual = tv({ stage: 'backlog' });
    const gone = tv({ planId: 'P1', stage: 'discarded' });
    const o = boardOverview([p1, p2, fu, fuOfFu, manual, gone], { board: gate, pauseAll: false, now });
    expect(o).toMatchObject({ total: 5, done: 2, remaining: 3 });
    expect(o.byColumn).toMatchObject({ done: 2, human_review: 1, ready: 1, backlog: 1 });
    expect(o.scope).toEqual([
      { planId: 'P1', planned: { total: 2, done: 1 }, followUps: { total: 2, done: 1 } },
      { planId: null, planned: { total: 1, done: 0 }, followUps: { total: 0, done: 0 } },
    ]);
    expect(o.needsYou.map((t) => t.id)).toEqual([p2.id]);
  });

  it('builds a daily series of at least 7 local days and a pace with an estimate', () => {
    const tasks = [
      tv({ createdAt: at(2), stage: 'done', startedAt: at(2), completedAt: at(1) }),
      tv({ createdAt: at(2), stage: 'done', startedAt: at(1.5), completedAt: at(1) }),
      tv({ createdAt: at(2), stage: 'ready' }),
      tv({ createdAt: at(0), stage: 'ready' }),
    ];
    const o = boardOverview(tasks, { board: gate, pauseAll: false, now });
    expect(o.days).toHaveLength(7);
    expect(o.days.at(-1)).toEqual({ day: localDay(now), done: 0, added: 1 });
    expect(o.days.find((d) => d.day === localDay(now - DAY))).toMatchObject({ done: 2 });
    expect(o.days.find((d) => d.day === localDay(now - 2 * DAY))).toMatchObject({ added: 3 });
    expect(o.pace).toEqual({ windowDays: 2, done: 2, perDay: 1, etaDays: 2 });
    expect(o.cycleMs).toBe(0.75 * DAY);
  });

  it('groups hold-ups and ranks the tasks that unblock the most', () => {
    const base = tv({ stage: 'implementing', touches: ['src/'] });
    const mid = tv({ stage: 'ready', deps: [dep(base)], waitingOn: [dep(base)] });
    const leaf = tv({ stage: 'backlog', deps: [dep(mid)], waitingOn: [dep(mid)] });
    const overlap = tv({ stage: 'ready', touches: ['src/a.ts'] });
    const free = tv({ stage: 'ready', touches: ['docs/'] });
    const o = boardOverview([base, mid, leaf, overlap, free], { board: gate, pauseAll: false, now });
    expect(o.holds.map((h) => [h.kind, h.tasks.map((t) => t.id)])).toEqual([
      ['ready', [free.id]],
      ['overlap', [overlap.id]],
      ['waiting', [mid.id, leaf.id]],
    ]);
    expect(o.unblockers.map((u) => [u.task.id, u.waiting])).toEqual([
      [base.id, 2],
      [mid.id, 1],
    ]);
    expect(o.running.map((t) => t.id)).toEqual([base.id]);
  });

  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
