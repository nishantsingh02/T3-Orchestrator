import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { events } from '../src/db/schema.ts';
import { runAction } from '../src/engine/actions.ts';
import { BACKGROUND_GRACE_MS, BACKGROUND_RECHECK_MS, BackgroundWatch } from '../src/engine/background.ts';
import { viewCtx } from '../src/engine/context.ts';
import { taskView } from '../src/db/views.ts';
import { holdingWork, normalizeBackgroundWork } from '../src/t3/T3Client.ts';
import { implDone, reviewPass, setup, type Harness } from './harness.ts';

let h: Harness;
let clock = 0;
afterEach(() => h?.cleanup());

/** A started task whose implementer turn just ended with "the tests still run in the background". */
async function endedInBackground(work: Parameters<Harness['fake']['setBackground']>[1] = [{ description: 'Run the full integration suite' }]) {
  h = await setup();
  clock = 1_000_000;
  h.ctx.background = new BackgroundWatch(h.fake, () => clock);
  const t = h.newTask({ title: 'Hourly learning cron' });
  await runAction(h.ctx, t.id, 'start', {});
  const threadId = h.task(t.id).threadId!;
  h.fake.setStatus(threadId, 'running');
  await h.tick();
  h.fake.finishRun(threadId, "The full integration suite is still running in the background. I'll report its result when it finishes.");
  h.fake.setBackground(threadId, work);
  await h.tick();
  return { taskId: t.id, threadId };
}

const view = (taskId: string) => taskView(h.db, taskId, viewCtx(h.ctx))!;

describe('a turn that ends while background work runs', () => {
  it('keeps the task implementing until T3 resumes the agent and it ends with its result', async () => {
    const { taskId, threadId } = await endedInBackground();
    expect(h.task(taskId).stage).toBe('implementing');
    expect(h.openRun(taskId)!.kind).toBe('implement');
    expect(view(taskId).activeRun!.background).toEqual(['Run the full integration suite']);
    const waits = h.db.select().from(events).where(eq(events.type, 'background_wait')).all();
    expect(waits.map((e) => e.payload)).toEqual([{ message: 'Run the full integration suite' }]);

    // Nothing changes in the thread: the run keeps waiting, and T3 is read again only now and then.
    const reads = () => h.fake.calls.filter((c) => c.op === 'backgroundWork').length;
    const before = reads();
    await h.tick();
    expect(reads()).toBe(before);
    clock += BACKGROUND_RECHECK_MS;
    await h.tick();
    expect(reads()).toBe(before + 1);
    expect(h.task(taskId).stage).toBe('implementing');

    // The suite is done: T3 resumes the agent by itself, which then ends with its result block.
    h.fake.setBackground(threadId);
    h.fake.agentContinues(threadId);
    await h.tick();
    expect(view(taskId).activeRun!.background).toEqual([]);
    h.fake.finishRun(threadId, implDone('all 628 integration tests pass'));
    await h.tick();
    const task = h.task(taskId);
    expect(task.stage).toBe('ai_review');
    expect(task.resultMissing).toBe(false);
    expect(task.lastSummary).toBe('all 628 integration tests pass');
    expect(h.runsOf(taskId).find((r) => r.kind === 'implement')!.status).toBe('completed');
  });

  it('gives T3 a moment to resume the agent after the work is done, then ends the run without it', async () => {
    const { taskId, threadId } = await endedInBackground();
    h.fake.setBackground(threadId);
    clock += BACKGROUND_RECHECK_MS;
    await h.tick();
    expect(h.task(taskId).stage).toBe('implementing');
    clock += BACKGROUND_GRACE_MS;
    await h.tick();
    const task = h.task(taskId);
    expect(task.stage).toBe('ai_review');
    expect(task.resultMissing).toBe(true);
  });

  it('does not wait on commands the agent does not wait on (dev servers) or on pull request watches', async () => {
    const { taskId } = await endedInBackground([
      { description: 'pnpm dev', awaited: false },
      { taskId: 'pull-request-watch:github.com/o/r#3', description: 'Watching pull request #3', kind: 'monitor' },
    ]);
    expect(h.task(taskId).stage).toBe('ai_review');
    expect(h.task(taskId).resultMissing).toBe(true);
  });

  it('keeps a waiting run waiting when T3 cannot be read, but does not start waiting on a failed read', async () => {
    const { taskId, threadId } = await endedInBackground();
    h.fake.failNextBackground = true;
    clock += BACKGROUND_RECHECK_MS;
    await h.tick();
    expect(h.task(taskId).stage).toBe('implementing');
    expect(h.ctx.health.healthy()).toBe(true);

    h.fake.agentContinues(threadId);
    await h.tick();
    h.fake.failNextBackground = true;
    h.fake.finishRun(threadId, 'Still checking.');
    await h.tick();
    expect(h.task(taskId).stage).toBe('ai_review');
  });

  it('holds the AI reviewer the same way', async () => {
    h = await setup();
    clock = 1_000_000;
    h.ctx.background = new BackgroundWatch(h.fake, () => clock);
    const t = h.newTask({ title: 'Add feature' });
    await runAction(h.ctx, t.id, 'start', {});
    await h.finish(t.id, implDone());
    const review = h.openRun(t.id)!;
    h.fake.setStatus(review.threadId!, 'running');
    await h.tick();
    h.fake.finishRun(review.threadId!, "I'll finish the review when the suite completes.");
    h.fake.setBackground(review.threadId!, [{ description: 'Integration tests', kind: 'subagent', awaited: false }]);
    await h.tick();
    expect(h.task(t.id).stage).toBe('ai_review');
    expect(view(t.id).activeRun!.background).toEqual(['Integration tests']);

    h.fake.setBackground(review.threadId!);
    h.fake.agentContinues(review.threadId!);
    h.fake.finishRun(review.threadId!, reviewPass());
    await h.tick();
    expect(h.task(t.id).stage).toBe('human_review');
    expect(h.task(t.id).stageReason).toBe('ai_passed');
  });
});

describe('background work from T3', () => {
  it('reads pendingBackgroundTasks out of the shell snapshot', () => {
    const map = normalizeBackgroundWork({
      threads: [
        { id: 'a', pendingBackgroundTasks: [{ taskId: 'b1', description: ' Run the full integration suite ', awaited: true, kind: 'command' }] },
        { id: 'b', pendingBackgroundTasks: [] },
        { id: 'c' },
        { id: 'd', pendingBackgroundTasks: [{ taskId: 'x', kind: 'subagent' }, { description: 'no id' }] },
        null,
      ],
    });
    expect([...map.keys()]).toEqual(['a', 'd']);
    expect(map.get('a')).toEqual([{ taskId: 'b1', kind: 'command', description: 'Run the full integration suite', awaited: true }]);
    expect(map.get('d')).toEqual([{ taskId: 'x', kind: 'subagent', description: null, awaited: false }]);
    expect(normalizeBackgroundWork(null).size).toBe(0);
  });

  it('holds completion like T3 does', () => {
    const task = (kind: string, awaited = false, taskId = 't') => ({ taskId, kind, description: null, awaited });
    expect(holdingWork([task('command'), task('monitor')])).toEqual([]);
    expect(holdingWork([task('command', true)])).toHaveLength(1);
    expect(holdingWork([task('monitor', true)])).toHaveLength(1);
    expect(holdingWork([task('subagent')])).toHaveLength(1);
    expect(holdingWork([task('background_task')])).toHaveLength(1);
    expect(holdingWork([task('monitor', true, 'pull-request-watch:github.com/o/r#1')])).toEqual([]);
  });
});
