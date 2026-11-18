import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAction } from '../src/engine/actions.ts';
import { T3CliError } from '../src/t3/T3Client.ts';
import { implDone, reviewPass, setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => {
  vi.restoreAllMocks();
  h?.cleanup();
});

/** A task taken through implement → AI review → manual approve, so it has a task and a review thread. */
async function doneTask(title = 'Feature') {
  const t = h.newTask({ title });
  await runAction(h.ctx, t.id, 'start', {});
  await h.finish(t.id, implDone());
  await h.finish(t.id, reviewPass());
  await runAction(h.ctx, t.id, 'approve', {});
  expect(h.task(t.id).stage).toBe('done');
  return t;
}

const threadsOf = (taskId: string) => [...new Set(h.runsOf(taskId).map((r) => r.threadId!))];
const settleCalls = () => h.fake.calls.filter((c) => c.op === 'settle').map((c) => c.args as string[]);
const settledEvents = (taskId: string) =>
  h.db.$client.prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'threads_settled'").all(taskId) as Array<{ payload: string }>;

describe('settling the T3 threads of done tasks', () => {
  it('settles the task and review threads once the task is done', async () => {
    h = await setup({ board: { mergeStrategy: 'manual' } });
    const t = await doneTask();
    const threads = threadsOf(t.id);
    expect(threads).toHaveLength(2);
    expect(settleCalls()).toEqual([]); // not before Done

    await h.tick();
    expect(settleCalls()).toEqual([threads]);
    for (const id of threads) expect(h.fake.get(id).detail.settled).toBe(true);
    expect(settledEvents(t.id).map((e) => JSON.parse(e.payload))).toEqual([{ threads: 2 }]);

    // Once per task: a thread the user brings back in T3 stays active.
    h.fake.get(threads[0]!).detail.settled = false;
    await h.tick();
    expect(settleCalls()).toHaveLength(1);
  });

  it('leaves tasks that are not done alone, and does nothing when the setting is off', async () => {
    h = await setup({ board: { mergeStrategy: 'manual' } });
    const review = h.newTask({ title: 'In review', complexity: 'trivial' });
    await runAction(h.ctx, review.id, 'start', {});
    await h.finish(review.id, implDone());
    expect(h.task(review.id).stage).toBe('human_review');

    h.ctx.settings.patch({ settleDoneThreads: false });
    const t = await doneTask();
    await h.tick();
    expect(settleCalls()).toEqual([]);

    h.ctx.settings.patch({ settleDoneThreads: true });
    await h.tick();
    expect(settleCalls()).toEqual([threadsOf(t.id)]);
    expect(settledEvents(review.id)).toEqual([]);
  });

  it('waits while someone is chatting with the agent of a done task', async () => {
    h = await setup({ board: { mergeStrategy: 'manual' } });
    const t = await doneTask();
    const taskThread = h.task(t.id).threadId!;
    h.fake.externalRun(taskThread);
    await h.tick();
    expect(settleCalls()).toEqual([]);

    h.fake.finishRun(taskThread, 'answered');
    await h.tick();
    expect(settleCalls()).toHaveLength(1);
    expect(h.fake.get(taskThread).detail.settled).toBe(true);
  });

  it('skips threads that are already settled or gone, and still marks the task', async () => {
    h = await setup({ board: { mergeStrategy: 'manual' } });
    const t = await doneTask();
    const [taskThread, reviewThread] = threadsOf(t.id);
    h.fake.get(taskThread!).detail.settled = true;
    h.fake.removeThread(reviewThread!);
    await h.tick();
    expect(settleCalls()).toEqual([]);
    expect(settledEvents(t.id)).toHaveLength(1);
  });

  it('retries after a failure, but not on every tick', async () => {
    h = await setup({ board: { mergeStrategy: 'manual' } });
    const t = await doneTask();
    const spy = vi.spyOn(h.fake, 'settleThreads').mockRejectedValueOnce(new T3CliError({ message: 'could not connect', code: 'EWS', unavailable: true }));
    await h.tick();
    await h.tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(settledEvents(t.id)).toEqual([]);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    await h.tick();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(settledEvents(t.id)).toHaveLength(1);
  });
});
