import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { boards, plans, reviewFindings, runs, settings as settingsTable, taskDeps, tasks } from '../src/db/schema.ts';
import { planDetailView } from '../src/db/views.ts';
import { runAction } from '../src/engine/actions.ts';
import { AppError } from '../src/engine/context.ts';
import { RefinePlanBody } from '@t3-orchestra/shared';
import { acceptPlan, createPlan, patchProposal, refinePlan } from '../src/engine/plans.ts';
import { insertRun } from '../src/engine/runs.ts';
import { planStarts } from '../src/engine/scheduler.ts';
import { applyTransition } from '../src/engine/transitions.ts';
import { patchTask } from '../src/engine/tasks.ts';
import { fence, implDone, reviewChanges, reviewPass, setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

async function startedTask(title = 'Add feature', extra: Parameters<Harness['newTask']>[0] = { title }) {
  const t = h.newTask({ ...extra, title });
  await runAction(h.ctx, t.id, 'start', {});
  return t;
}

describe('implement → needs input → AI review → human review', () => {
  it('follows the thread timeline', async () => {
    h = await setup();
    const t = await startedTask('Add OAuth callback');
    let task = h.task(t.id);
    expect(task.stage).toBe('implementing');
    expect(task.branch).toBe(`t3orchestra/${h.board.slug}/1-add-oauth-callback`);
    const start = h.fake.calls.find((c) => c.op === 'start')!.args as { title: string; worktree: { baseRef: string; branch: string }; message: string };
    expect(start.title).toBe(`#1 Add OAuth callback [tb ${h.board.short}-1]`);
    expect(start.worktree).toEqual({ baseRef: 'main', branch: task.branch });
    expect(start.message).toContain('task #1 of the board "Test Board"');
    expect(task.threadId).toBeTruthy();
    expect(task.threadLink).toMatch(/^https:/);

    // running → waiting: attention + notification
    h.fake.setStatus(task.threadId!, 'running');
    await h.tick();
    expect(h.view(t.id).column).toBe('running');
    h.fake.setStatus(task.threadId!, 'waiting', { pendingRequestCount: 1 });
    await h.tick();
    expect(h.view(t.id).column).toBe('needs_input');
    expect(h.task(t.id).attention).toBe('waiting');
    expect(h.notifications().map((n) => n.type)).toContain('task_attention');

    // back to running: attention clears
    h.fake.setStatus(task.threadId!, 'running', { pendingRequestCount: 0 });
    await h.tick();
    expect(h.task(t.id).attention).toBeNull();
    expect(h.view(t.id).column).toBe('running');

    // completed with a result → ai_review with a reviewer thread in the project root
    h.fake.finishRun(task.threadId!, implDone('built the callback'));
    await h.tick();
    task = h.task(t.id);
    expect(task.stage).toBe('ai_review');
    expect(task.lastSummary).toBe('built the callback');
    expect(task.reviewRound).toBe(1);
    const review = h.openRun(t.id)!;
    expect(review.kind).toBe('review');
    expect(review.round).toBe(1);
    const reviewStart = h.fake.calls.filter((c) => c.op === 'start')[1]!.args as { title: string; worktree?: unknown; message: string };
    expect(reviewStart.title).toContain(`[tb ${h.board.short}-1 r1]`);
    expect(reviewStart.worktree).toBeUndefined();
    expect(reviewStart.message).toContain('review round 1');

    await h.finish(t.id, reviewPass());
    task = h.task(t.id);
    expect(task.stage).toBe('human_review');
    expect(task.stageReason).toBe('ai_passed');
    expect(h.notifications().some((n) => n.type === 'human_review' && n.title.includes('AI passed'))).toBe(true);
  });
});

describe('AI review loop (spec §5.6)', () => {
  it('changes requested → fix round → pass', async () => {
    h = await setup();
    const t = await startedTask();
    await h.finish(t.id, implDone());
    await h.finish(t.id, reviewChanges('major'));
    let task = h.task(t.id);
    expect(task.stage).toBe('implementing');
    expect(task.fixRound).toBe(1);
    const fix = h.openRun(t.id)!;
    expect(fix.kind).toBe('fix');
    expect(fix.threadId).toBe(task.threadId);
    const sent = h.fake.calls.filter((c) => c.op === 'send').at(-1)!.args as { message: string };
    expect(sent.message).toContain('[major] a.ts:1: Bug');
    expect(h.db.select().from(reviewFindings).all()).toHaveLength(1);

    await h.finish(t.id, implDone('fixed'));
    task = h.task(t.id);
    expect(task.stage).toBe('ai_review');
    expect(task.reviewRound).toBe(2);
    const r2 = h.fake.calls.filter((c) => c.op === 'start').at(-1)!.args as { message: string };
    expect(r2.message).toContain('Findings from the previous round');

    await h.finish(t.id, reviewPass());
    task = h.task(t.id);
    expect(task.stage).toBe('human_review');
    expect(task.stageReason).toBe('ai_passed');
    const findings = h.db.select().from(reviewFindings).all();
    expect(findings.map((f) => f.status)).toEqual(['addressed']);
  });

  it('changes requested with no rounds left → ai_unresolved', async () => {
    h = await setup({ board: { maxFixRounds: 0 } });
    const t = await startedTask();
    await h.finish(t.id, implDone());
    await h.finish(t.id, reviewChanges('blocker'));
    const task = h.task(t.id);
    expect(task.stage).toBe('human_review');
    expect(task.stageReason).toBe('ai_unresolved');
    expect(h.view(t.id).findings.open).toEqual({ blocker: 1 });
    expect(h.notifications().some((n) => n.title.includes('1 blocker unresolved'))).toBe(true);
  });

  it('retry fresh drops the previous attempt\'s findings from the counts and the next review', async () => {
    h = await setup({ board: { maxFixRounds: 1 } });
    const t2 = await startedTask('Second');
    await h.finish(t2.id, implDone());
    await h.finish(t2.id, reviewChanges('major'));
    await h.finish(t2.id, 'gave up', 'failed');
    expect(h.task(t2.id).stage).toBe('failed');
    expect(h.view(t2.id).findings.open).toEqual({ major: 1 });
    await runAction(h.ctx, t2.id, 'retry-fresh', {});
    expect(h.view(t2.id).findings.open).toEqual({});
    await h.finish(t2.id, implDone());
    const reviewPrompt = h.fake.calls.filter((c) => c.op === 'start').at(-1)!.args as { message: string };
    expect(reviewPrompt.message).not.toContain('Findings from the previous round');
  });

  it('findings below the strictness threshold do not start a fix round', async () => {
    h = await setup({ board: { reviewStrictness: 'major' } });
    const t = await startedTask();
    await h.finish(t.id, implDone());
    await h.finish(t.id, reviewChanges('minor'));
    expect(h.task(t.id)).toMatchObject({ stage: 'human_review', stageReason: 'ai_passed' });
    // Nobody was asked to fix them, so the next review has nothing to verify.
    await runAction(h.ctx, t.id, 'rerun-review', {});
    const r2 = h.fake.calls.filter((c) => c.op === 'start').at(-1)!.args as { message: string };
    expect(r2.message).not.toContain('Findings from the previous round');
  });

  it('the reviewer sees the checks the implementer ran', async () => {
    h = await setup();
    const t = await startedTask();
    await h.finish(t.id, fence({ status: 'done', summary: 'did it', testsRun: ['pnpm test:integration → 700 passed'] }));
    const review = h.fake.calls.filter((c) => c.op === 'start').at(-1)!.args as { message: string };
    expect(review.message).toContain('- pnpm test:integration → 700 passed');
    expect(review.message).toContain('Do not re-run a slow suite');

    const t2 = await startedTask('No checks');
    await h.finish(t2.id, implDone());
    const review2 = h.fake.calls.filter((c) => c.op === 'start').at(-1)!.args as { message: string };
    expect(review2.message).toContain('(none reported: run the checks you need)');
    expect(review2.message).not.toContain('Do not re-run a slow suite');
  });

  it('an invalid review result → review_failed, and re-run review works', async () => {
    h = await setup();
    const t = await startedTask();
    await h.finish(t.id, implDone());
    await h.finish(t.id, 'I reviewed it and it is fine.');
    expect(h.task(t.id)).toMatchObject({ stage: 'human_review', stageReason: 'review_failed' });
    await runAction(h.ctx, t.id, 'rerun-review', {});
    expect(h.task(t.id)).toMatchObject({ stage: 'ai_review', reviewRound: 2 });
  });

  it('trivial tasks skip review when skipReviewForTrivial is on', async () => {
    h = await setup();
    const t = await startedTask('Fix typo', { title: 'x', complexity: 'trivial' });
    await h.finish(t.id, implDone());
    expect(h.task(t.id)).toMatchObject({ stage: 'human_review', stageReason: 'ai_review_skipped' });
  });

  it('a missing result block still goes to AI review, flagged', async () => {
    h = await setup();
    const t = await startedTask();
    await h.finish(t.id, 'finished, no block');
    expect(h.task(t.id)).toMatchObject({ stage: 'ai_review', resultMissing: true });
  });
});

describe('failures (spec §5.8)', () => {
  it('blocked result → failed(agent_blocked)', async () => {
    h = await setup();
    const t = await startedTask();
    await h.finish(t.id, fence({ status: 'blocked', summary: 'stuck', blockedReason: 'Which database?' }));
    expect(h.task(t.id)).toMatchObject({ stage: 'failed', stageReason: 'agent_blocked', lastMessage: 'Which database?' });
    expect(h.notifications().some((n) => n.type === 'task_failed')).toBe(true);
  });

  it('interrupted run → failed(run_interrupted), then resume on the same thread', async () => {
    h = await setup();
    const t = await startedTask();
    await h.finish(t.id, 'partial work', 'interrupted');
    const task = h.task(t.id);
    expect(task).toMatchObject({ stage: 'failed', stageReason: 'run_interrupted' });
    await runAction(h.ctx, t.id, 'resume', { note: 'keep going' });
    const resumed = h.task(t.id);
    expect(resumed.stage).toBe('implementing');
    expect(resumed.threadId).toBe(task.threadId);
    const sent = h.fake.calls.filter((c) => c.op === 'send').at(-1)!.args as { message: string };
    expect(sent.message).toContain('ended with status `interrupted`');
    expect(sent.message).toContain('keep going');
  });

  it('retry fresh → new thread and a -r2 branch', async () => {
    h = await setup();
    const t = await startedTask('Do thing');
    await h.finish(t.id, 'x', 'failed');
    const before = h.task(t.id);
    await runAction(h.ctx, t.id, 'retry-fresh', {});
    const after = h.task(t.id);
    expect(after.stage).toBe('implementing');
    expect(after.threadId).not.toBe(before.threadId);
    expect(after.branch).toBe(`t3orchestra/${h.board.slug}/1-do-thing-r2`);
  });

  it('a vanished thread → failed(thread_missing)', async () => {
    h = await setup();
    const t = await startedTask();
    h.fake.removeThread(h.task(t.id).threadId!);
    await h.tick();
    expect(h.task(t.id)).toMatchObject({ stage: 'failed', stageReason: 'thread_missing' });
    expect(h.runsOf(t.id)[0]!.status).toBe('lost');
  });

  it('failed → backlog resets the thread link and bumps the branch attempt', async () => {
    h = await setup();
    const t = await startedTask('Do thing');
    await h.finish(t.id, 'x', 'failed');
    await runAction(h.ctx, t.id, 'move-to-backlog', {});
    expect(h.task(t.id)).toMatchObject({ stage: 'backlog', threadId: null, attempt: 2 });
  });
});

describe('start idempotency and crash recovery (spec §15.3)', () => {
  it('start that errors after creating the thread is recovered by title marker', async () => {
    h = await setup();
    h.fake.failNextStart = { afterCreate: true };
    const t = await startedTask();
    const task = h.task(t.id);
    expect(task.stage).toBe('implementing');
    expect(task.threadId).toBeTruthy();
    expect(h.runsOf(t.id)[0]!.status).toBe('active');
  });

  it('start that never created a thread → failed(start_failed)', async () => {
    h = await setup();
    h.fake.failNextStart = { afterCreate: false };
    const t = await startedTask();
    expect(h.task(t.id)).toMatchObject({ stage: 'failed', stageReason: 'start_failed' });
    expect(h.runsOf(t.id)[0]!.status).toBe('failed');
  });

  it('a run left `starting` by a crash is resolved on the next tick', async () => {
    h = await setup();
    const t = h.newTask({ title: 'Crashy' });
    // Simulate: transaction committed, process died before calling T3.
    applyTransition(h.db, t.id, { type: 'user.start' }, {
      also: (tx) =>
        insertRun(tx, {
          boardId: h.board.id,
          taskId: t.id,
          kind: 'implement',
          threadRole: 'task',
          promptText: 'p',
          marker: `[tb ${h.board.short}-1]`,
          launch: { project: h.repo, title: `#1 Crashy [tb ${h.board.short}-1]` },
        }),
    });
    await h.tick();
    expect(h.task(t.id)).toMatchObject({ stage: 'failed', stageReason: 'start_failed' });

    // Same, but the thread did get created before the crash.
    const t2 = h.newTask({ title: 'Crashy two' });
    await h.fake.startThread({ project: h.repo, message: 'p', title: `#2 Crashy two [tb ${h.board.short}-2]` });
    applyTransition(h.db, t2.id, { type: 'user.start' }, {
      also: (tx) =>
        insertRun(tx, {
          boardId: h.board.id,
          taskId: t2.id,
          kind: 'implement',
          threadRole: 'task',
          promptText: 'p',
          marker: `[tb ${h.board.short}-2]`,
          launch: { project: h.repo, title: `#2 Crashy two [tb ${h.board.short}-2]` },
        }),
    });
    await h.tick();
    expect(h.task(t2.id)).toMatchObject({ stage: 'implementing' });
    expect(h.task(t2.id).threadId).toBeTruthy();
  });

  it('a send that errors but went through is treated as sent', async () => {
    h = await setup();
    const t = await startedTask();
    await h.finish(t.id, 'x', 'interrupted');
    h.fake.failNextSend = { afterSend: true };
    await runAction(h.ctx, t.id, 'resume', {});
    expect(h.task(t.id).stage).toBe('implementing');
    expect(h.openRun(t.id)!.status).toBe('active');
  });

  it('a backend restart mid-run catches up from SQLite', async () => {
    h = await setup();
    const t = await startedTask();
    const threadId = h.task(t.id).threadId!;
    // "Restart": a brand-new engine over the same DB and the same T3.
    const { Engine } = await import('../src/engine/engine.ts');
    const engine2 = new Engine({ db: h.db, t3: h.fake, config: h.ctx.config, desktop: null, healthIntervalMs: 1e9 });
    engine2.ctx.kick = () => {};
    await engine2.ctx.health.check();
    h.fake.finishRun(threadId, implDone());
    await engine2.reconciler.tick();
    expect(h.task(t.id).stage).toBe('ai_review');
  });
});

describe('human review actions', () => {
  async function inReview() {
    const t = await startedTask('Feature', { title: 'x', complexity: 'trivial' });
    await h.finish(t.id, implDone());
    expect(h.task(t.id).stage).toBe('human_review');
    return t;
  }

  it('request changes resets fixRound and re-reviews afterwards', async () => {
    h = await setup({ board: { skipReviewForTrivial: false } });
    const t = h.newTask({ title: 'Feature' });
    await runAction(h.ctx, t.id, 'start', {});
    await h.finish(t.id, implDone());
    await h.finish(t.id, reviewChanges());
    await h.finish(t.id, implDone());
    await h.finish(t.id, reviewPass());
    expect(h.task(t.id).fixRound).toBe(1);
    await runAction(h.ctx, t.id, 'request-changes', { text: 'rename it' });
    expect(h.task(t.id)).toMatchObject({ stage: 'implementing', fixRound: 0 });
    expect(h.openRun(t.id)!.kind).toBe('changes');
    await h.finish(t.id, implDone());
    expect(h.task(t.id).stage).toBe('ai_review');
  });

  it('manual merge strategy: approve marks done', async () => {
    h = await setup({ board: { mergeStrategy: 'manual' } });
    const t = await inReview();
    await runAction(h.ctx, t.id, 'approve', {});
    expect(h.task(t.id).stage).toBe('done');
    expect(h.task(t.id).completedAt).toBeTruthy();
    expect(h.notifications().some((n) => n.type === 'board_done')).toBe(true);
  });

  it('PR strategy: approve sends the PR message, and the PR run returns to human review without re-review', async () => {
    h = await setup({ board: { mergeStrategy: 'pr' } });
    const t = await inReview();
    await runAction(h.ctx, t.id, 'approve', {});
    expect(h.openRun(t.id)!.kind).toBe('pr');
    const thread = h.fake.get(h.task(t.id).threadId!);
    thread.detail.pullRequests = [{ url: 'https://github.com/x/y/pull/9', state: 'open' }];
    await h.finish(t.id, implDone('opened PR'));
    expect(h.task(t.id)).toMatchObject({ stage: 'human_review', stageReason: 'pr_opened', prUrl: 'https://github.com/x/y/pull/9' });
  });

  it('agent activity since review is flagged without changing the stage', async () => {
    h = await setup();
    const t = await inReview();
    h.fake.externalRun(h.task(t.id).threadId!);
    await h.tick();
    expect(h.task(t.id)).toMatchObject({ stage: 'human_review', activitySinceReview: true });
  });

  it('illegal actions are refused and logged, never thrown as 500s', async () => {
    h = await setup();
    const t = h.newTask({ title: 'x' });
    await expect(runAction(h.ctx, t.id, 'mark-done', {})).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    const ev = h.db.$client.prepare("SELECT type FROM events WHERE task_id = ? AND type = 'illegal_transition'").all(t.id);
    expect(ev).toHaveLength(1);
  });

  it('start with unmet deps needs force', async () => {
    h = await setup();
    const a = h.newTask({ title: 'A' });
    const b = h.newTask({ title: 'B', dependsOn: [a.id] });
    await expect(runAction(h.ctx, b.id, 'start', {})).rejects.toMatchObject({ code: 'DEPS_NOT_DONE' });
    await runAction(h.ctx, b.id, 'start', { force: true });
    expect(h.task(b.id).stage).toBe('implementing');
  });

  it('PATCH rejects dependency cycles', async () => {
    h = await setup();
    const a = h.newTask({ title: 'A' });
    const b = h.newTask({ title: 'B', dependsOn: [a.id] });
    expect(() => patchTask(h.ctx, a.id, { dependsOn: [b.id] })).toThrow(AppError);
    try {
      patchTask(h.ctx, a.id, { dependsOn: [b.id] });
    } catch (err) {
      expect((err as AppError).code).toBe('DEP_CYCLE');
    }
  });
});

describe('scheduler (spec §7)', () => {
  const ready = async (title: string, extra: Partial<Parameters<Harness['newTask']>[0]> = {}) => {
    const t = h.newTask({ title, ...extra });
    await runAction(h.ctx, t.id, 'move-to-ready', {});
    return t;
  };

  it('fills slots up to maxParallel in priority/position order', async () => {
    h = await setup({ board: { autoRun: true, maxParallel: 2 } });
    const a = await ready('A', { priority: 'low' });
    const b = await ready('B');
    const c = await ready('C', { priority: 'high' });
    await h.engine.scheduler.run();
    const stages = [a, b, c].map((t) => h.task(t.id).stage);
    expect(stages).toEqual(['ready', 'implementing', 'implementing']);
  });

  it('starts dependents only after dependencies are done', async () => {
    h = await setup({ board: { autoRun: true, maxParallel: 3, mergeStrategy: 'manual' } });
    const a = await ready('A', { complexity: 'trivial' });
    const b = await ready('B', { dependsOn: [a.id] });
    await h.engine.scheduler.run();
    expect(h.task(a.id).stage).toBe('implementing');
    expect(h.task(b.id).stage).toBe('ready');
    await h.finish(a.id, implDone());
    expect(h.task(a.id).stage).toBe('human_review');
    await h.engine.scheduler.run();
    expect(h.task(b.id).stage).toBe('ready');
    await runAction(h.ctx, a.id, 'approve', {});
    await h.engine.scheduler.run();
    expect(h.task(b.id).stage).toBe('implementing');
  });

  it('avoids overlapping touches, respects pause, the global limit and the health gate', async () => {
    h = await setup({ board: { autoRun: true, maxParallel: 5 } });
    await ready('A', { touches: ['src/auth/'] });
    const b = await ready('B', { touches: ['src/auth/login.ts'] });
    const c = await ready('C', { touches: ['src/ui/'] });
    h.ctx.settings.patch({ pauseAll: true });
    expect(planStarts(h.ctx)).toEqual([]);
    h.ctx.settings.patch({ pauseAll: false, globalMaxParallel: 6 });
    h.fake.healthy = false;
    await h.ctx.health.check();
    expect(planStarts(h.ctx)).toEqual([]);
    h.fake.healthy = true;
    await h.ctx.health.check();
    await h.engine.scheduler.run();
    expect(h.task(b.id).stage).toBe('ready');
    expect(h.task(c.id).stage).toBe('implementing');
    h.ctx.settings.patch({ globalMaxParallel: 2 });
    const d = await ready('D');
    await h.engine.scheduler.run();
    expect(h.task(d.id).stage).toBe('ready');
  });

  it('"run next" goes first, skips the overlap gate, and is cleared once it starts', async () => {
    h = await setup({ board: { autoRun: true, maxParallel: 2 } });
    const running = await startedTask('Running', { title: 'Running', touches: ['src/api/'] });
    const high = await ready('High', { priority: 'high' });
    const pinned = await ready('Pinned', { priority: 'low', touches: ['src/api/x.ts'] });
    patchTask(h.ctx, pinned.id, { runNext: true });
    expect(h.task(pinned.id)).toMatchObject({ runNext: true });
    // Moved to the top of Ready.
    expect(h.task(pinned.id).position).toBeLessThan(h.task(high.id).position);
    await h.engine.scheduler.run();
    expect(h.task(running.id).stage).toBe('implementing');
    expect(h.task(pinned.id)).toMatchObject({ stage: 'implementing', runNext: false });
    expect(h.task(high.id).stage).toBe('ready');
  });

  it('one "run next" task per board, Ready only, and moving it out of Ready clears it', async () => {
    h = await setup({ board: { autoRun: false } });
    const a = await ready('A');
    const b = await ready('B');
    const backlog = h.newTask({ title: 'Backlog' });
    patchTask(h.ctx, a.id, { runNext: true });
    patchTask(h.ctx, b.id, { runNext: true });
    expect([h.task(a.id).runNext, h.task(b.id).runNext]).toEqual([false, true]);
    expect(() => patchTask(h.ctx, backlog.id, { runNext: true })).toThrow(/only Ready tasks/);
    await runAction(h.ctx, b.id, 'move-to-backlog', {});
    expect(h.task(b.id).runNext).toBe(false);
  });

  it('auto-run off starts nothing', async () => {
    h = await setup({ board: { autoRun: false } });
    const a = await ready('A');
    await h.engine.scheduler.run();
    expect(h.task(a.id).stage).toBe('ready');
  });
});

describe('T3 down (spec §15.1)', () => {
  it('refuses starts, marks nothing failed, and catches up when back', async () => {
    h = await setup();
    const t = await startedTask();
    h.fake.healthy = false;
    await h.ctx.health.check();
    const other = h.newTask({ title: 'Other' });
    await expect(runAction(h.ctx, other.id, 'start', {})).rejects.toMatchObject({ code: 'T3_UNAVAILABLE' });
    await h.tick();
    expect(h.task(t.id).stage).toBe('implementing');
    h.fake.healthy = true;
    h.fake.finishRun(h.task(t.id).threadId!, implDone());
    await h.tick();
    expect(h.task(t.id).stage).toBe('ai_review');
  });
});

describe('planner (spec §5.2–5.3)', () => {
  const planJson = (extra: object[] = []) =>
    fence({
      summary: 'Split it.',
      assumptions: ['TS'],
      tasks: [
        { key: 'T1', title: 'Scaffold', description: 'd', acceptanceCriteria: ['a'], complexity: 'small', category: 'infra' },
        { key: 'T2', title: 'Feature', description: 'd', acceptanceCriteria: ['a'], complexity: 'medium', category: 'feature', dependsOn: ['T1'] },
        ...extra,
      ],
    });

  it('invalid output gets one correction, then the plan is ready and accepted with deps', async () => {
    h = await setup();
    const plan = await createPlan(h.ctx, h.board.id, { prompt: 'Build a login system\nwith OAuth', options: { maxTasks: 20, askQuestions: true, extraGuidance: '' } });
    expect(plan.status).toBe('planning');
    expect(plan.title).toBe('Build a login system');
    const threadId = h.db.select().from(plans).where(eq(plans.id, plan.id)).get()!.threadId!;
    const start = h.fake.calls[0]!.args as { title: string; worktree?: unknown; message: string };
    expect(start.title).toContain(`[tb ${h.board.short} plan-1]`);
    expect(start.worktree).toBeUndefined();
    expect(start.message).toContain('## GOAL\nBuild a login system');

    h.fake.finishRun(threadId, fence({ summary: 's', tasks: [{ key: 'T1', title: 'x' }] }));
    await h.tick();
    let p = h.db.select().from(plans).where(eq(plans.id, plan.id)).get()!;
    expect(p.correctionSent).toBe(true);
    expect((h.fake.calls.at(-1)!.args as { message: string }).message).toContain('could not be used');

    h.fake.setStatus(threadId, 'running');
    await h.tick();
    h.fake.finishRun(threadId, planJson());
    await h.tick();
    p = h.db.select().from(plans).where(eq(plans.id, plan.id)).get()!;
    expect(p.status).toBe('ready');
    const detail = planDetailView(h.db, p);
    expect(detail.proposals.map((x) => x.key)).toEqual(['T1', 'T2']);
    expect(h.notifications().some((n) => n.type === 'plan_ready')).toBe(true);

    patchProposal(h.ctx, plan.id, 'T2', { title: 'Feature (edited)' });
    const edited = planDetailView(h.db, h.db.select().from(plans).where(eq(plans.id, plan.id)).get()!);
    expect(edited.changedKeys).toEqual(['T2']);
    expect(edited.versions.at(-1)!.source).toBe('user');

    expect(() => acceptPlan(h.ctx, plan.id, ['T2'])).toThrow(/Also select the dependencies/);
    const { tasks: created } = acceptPlan(h.ctx, plan.id);
    expect(created.map((t) => [t.number, t.title, t.stage])).toEqual([
      [1, 'Scaffold', 'ready'],
      [2, 'Feature (edited)', 'ready'],
    ]);
    const deps = h.db.select().from(taskDeps).all();
    expect(deps).toEqual([{ taskId: created[1]!.id, dependsOnTaskId: created[0]!.id }]);
    const board = h.db.select().from(boards).where(eq(boards.id, h.board.id)).get()!;
    expect(board.brief).toContain('## Plan #1: Build a login system');
    expect(board.nextTaskNumber).toBe(3);
  });

  it('still invalid after the correction → failed', async () => {
    h = await setup();
    const plan = await createPlan(h.ctx, h.board.id, { prompt: 'Goal', options: { maxTasks: 20, askQuestions: false, extraGuidance: '' } });
    const threadId = h.db.select().from(plans).where(eq(plans.id, plan.id)).get()!.threadId!;
    h.fake.finishRun(threadId, 'no block');
    await h.tick();
    h.fake.setStatus(threadId, 'running');
    await h.tick();
    h.fake.finishRun(threadId, 'still no block');
    await h.tick();
    const p = h.db.select().from(plans).where(eq(plans.id, plan.id)).get()!;
    expect(p.status).toBe('failed');
    expect(p.error).toMatch(/still invalid/);
  });

  it('refine sends answers to open questions, and the reply becomes v2', async () => {
    expect(RefinePlanBody.safeParse({ feedback: ' ', answers: [] }).success).toBe(false);
    h = await setup();
    const plan = await createPlan(h.ctx, h.board.id, { prompt: 'Goal', options: { maxTasks: 20, askQuestions: false, extraGuidance: '' } });
    const threadId = h.db.select().from(plans).where(eq(plans.id, plan.id)).get()!.threadId!;
    h.fake.finishRun(threadId, planJson());
    await h.tick();

    await refinePlan(h.ctx, plan.id, RefinePlanBody.parse({ answers: [{ question: 'Dark mode?', answer: 'Yes, follow the OS.' }] }));
    const sent = h.fake.calls.filter((c) => c.op === 'send').at(-1)!.args as { message: string };
    expect(sent.message).toContain('## Answers to your open questions\n\nQ: Dark mode?\nA: Yes, follow the OS.');
    expect(sent.message).not.toContain('## Feedback');
    expect(h.db.select().from(plans).where(eq(plans.id, plan.id)).get()!.status).toBe('refining');

    h.fake.setStatus(threadId, 'running');
    await h.tick();
    h.fake.finishRun(threadId, planJson([{ key: 'T3', title: 'Dark mode', description: 'd', acceptanceCriteria: ['a'], complexity: 'small', category: 'design' }]));
    await h.tick();
    const p = h.db.select().from(plans).where(eq(plans.id, plan.id)).get()!;
    expect(p.status).toBe('ready');
    expect(p.currentVersion).toBe(2);
    expect(planDetailView(h.db, p).addedKeys).toEqual(['T3']);
  });

  it('planner asking a question → needs_input', async () => {
    h = await setup();
    const plan = await createPlan(h.ctx, h.board.id, { prompt: 'Goal', options: { maxTasks: 20, askQuestions: true, extraGuidance: '' } });
    const threadId = h.db.select().from(plans).where(eq(plans.id, plan.id)).get()!.threadId!;
    h.fake.setStatus(threadId, 'waiting', { pendingRequestCount: 1 });
    await h.tick();
    expect(h.db.select().from(plans).where(eq(plans.id, plan.id)).get()!.status).toBe('needs_input');
    expect(h.notifications().some((n) => n.type === 'plan_input')).toBe(true);
  });
});

describe('persistence', () => {
  it('settings round-trip through SQLite', async () => {
    h = await setup();
    h.ctx.settings.patch({ pollActiveMs: 3000, notifications: { sound: true } });
    const rows = h.db.select().from(settingsTable).all();
    expect(rows.map((r) => r.key).sort()).toEqual(['notifications', 'pollActiveMs']);
    const { SettingsStore } = await import('../src/settings.ts');
    const fresh = new SettingsStore(h.db).get();
    expect(fresh.pollActiveMs).toBe(3000);
    expect(fresh.notifications.sound).toBe(true);
    expect(fresh.notifications.desktop).toBe(true);
  });

  it('every stage change writes an events row', async () => {
    h = await setup();
    const t = await startedTask();
    await h.finish(t.id, implDone());
    const types = h.db.$client.prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'stage_changed' ORDER BY id").all(t.id) as Array<{ payload: string }>;
    expect(types.map((r) => JSON.parse(r.payload).to)).toEqual(['backlog', 'implementing', 'ai_review']);
    expect(h.db.select().from(runs).all().length).toBe(2);
    expect(h.db.select().from(tasks).all().length).toBe(1);
  });
});
