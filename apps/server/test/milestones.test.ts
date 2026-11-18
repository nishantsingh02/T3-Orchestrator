import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { milestones, plans, tasks } from '../src/db/schema.ts';
import { runAction } from '../src/engine/actions.ts';
import {
  addSuggestions,
  boardSuggestions,
  createMilestone,
  deleteMilestone,
  dismissSuggestions,
  listMilestones,
  patchMilestone,
} from '../src/engine/milestones.ts';
import { acceptPlan, createPlan } from '../src/engine/plans.ts';
import { planStarts } from '../src/engine/scheduler.ts';
import { patchTask } from '../src/engine/tasks.ts';
import { fence, setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

const task = (key: string, milestone: string | undefined, extra: object = {}) => ({
  key,
  title: `Task ${key}`,
  description: 'd',
  acceptanceCriteria: ['a'],
  complexity: 'small',
  category: 'feature',
  ...(milestone ? { milestone } : {}),
  ...extra,
});

async function readyPlan(result: object, prompt = 'Goal') {
  const plan = await createPlan(h.ctx, h.board.id, { prompt, options: { maxTasks: 20, askQuestions: false, extraGuidance: '' } });
  const threadId = h.db.select().from(plans).where(eq(plans.id, plan.id)).get()!.threadId!;
  h.fake.finishRun(threadId, fence(result));
  await h.tick();
  return { plan, threadId };
}

describe('milestones', () => {
  it('accepting a plan creates its milestones in order and reuses ones the board has', async () => {
    h = await setup();
    const { plan } = await readyPlan({
      summary: 's',
      milestones: [
        { title: 'Sign-up works', goal: 'Users can sign up' },
        { title: 'Profiles', goal: 'Users edit profiles' },
        { title: 'Unused', goal: 'No task points here' },
      ],
      tasks: [task('T1', 'Profiles'), task('T2', 'Sign-up works'), task('T3', undefined), task('T4', 'Extra')],
    });
    const { tasks: created } = acceptPlan(h.ctx, plan.id);
    const ms = listMilestones(h.db, h.board.id);
    expect(ms.map((m) => [m.number, m.title, m.goal, m.planId])).toEqual([
      [1, 'Sign-up works', 'Users can sign up', plan.id],
      [2, 'Profiles', 'Users edit profiles', plan.id],
      [3, 'Extra', '', plan.id],
    ]);
    const byKey = new Map(created.map((t) => [t.planKey, t.milestoneId]));
    expect(byKey.get('T1')).toBe(ms[1]!.id);
    expect(byKey.get('T2')).toBe(ms[0]!.id);
    expect(byKey.get('T3')).toBeNull();
    expect(byKey.get('T4')).toBe(ms[2]!.id);

    // The next plan sees the milestones, and a task naming one (any case) joins it.
    const { plan: second } = await readyPlan({ summary: 's', tasks: [task('T1', 'profiles')] }, 'More');
    const start = h.fake.calls.filter((c) => c.op === 'start').at(-1)!.args as { message: string };
    expect(start.message).toContain('## Milestones on this board\n- Sign-up works — Users can sign up (0/1 tasks done)');
    const { tasks: more } = acceptPlan(h.ctx, second.id);
    expect(more[0]!.milestoneId).toBe(ms[1]!.id);
    expect(listMilestones(h.db, h.board.id)).toHaveLength(3);
  });

  it('edits, reorders and deletes milestones; deleting keeps the tasks', async () => {
    h = await setup();
    const m1 = createMilestone(h.ctx, h.board.id, { title: 'One', goal: '' });
    const m2 = createMilestone(h.ctx, h.board.id, { title: 'Two', goal: 'g' });
    expect([m1.number, m2.number]).toEqual([1, 2]);
    patchMilestone(h.ctx, m2.id, { position: m1.position - 1, title: 'Second' });
    expect(listMilestones(h.db, h.board.id).map((m) => m.title)).toEqual(['Second', 'One']);

    const t = h.newTask({ title: 'In one', milestoneId: m1.id });
    expect(h.task(t.id).milestoneId).toBe(m1.id);
    patchTask(h.ctx, t.id, { milestoneId: m2.id });
    expect(h.task(t.id).milestoneId).toBe(m2.id);

    const other = await setup();
    const foreign = createMilestone(other.ctx, other.board.id, { title: 'Elsewhere', goal: '' });
    expect(() => patchTask(h.ctx, t.id, { milestoneId: foreign.id })).toThrow(/same board/);
    other.cleanup();

    deleteMilestone(h.ctx, m2.id);
    expect(h.task(t.id).milestoneId).toBeNull();
    expect(h.db.select().from(milestones).all().map((m) => m.title)).toEqual(['One']);
    // Numbers are not reused.
    expect(createMilestone(h.ctx, h.board.id, { title: 'Three', goal: '' }).number).toBe(3);
  });

  it('auto-run starts tasks of earlier milestones first, tasks without one last', async () => {
    h = await setup({ board: { autoRun: true, maxParallel: 1 } });
    const m1 = createMilestone(h.ctx, h.board.id, { title: 'First', goal: '' });
    const m2 = createMilestone(h.ctx, h.board.id, { title: 'Second', goal: '' });
    const loose = h.newTask({ title: 'Loose', priority: 'high' });
    const later = h.newTask({ title: 'Later', priority: 'high', milestoneId: m2.id });
    const first = h.newTask({ title: 'First task', priority: 'low', milestoneId: m1.id });
    for (const t of [loose, later, first]) await runAction(h.ctx, t.id, 'move-to-ready', {});
    expect(planStarts(h.ctx)[0]!.start.map((t) => t.id)).toEqual([first.id]);
    patchMilestone(h.ctx, m2.id, { position: m1.position - 1 });
    expect(planStarts(h.ctx)[0]!.start.map((t) => t.id)).toEqual([later.id]);
    patchTask(h.ctx, later.id, { milestoneId: null });
    patchTask(h.ctx, first.id, { milestoneId: null });
    // Without milestones, priority decides again.
    expect(planStarts(h.ctx)[0]!.start.map((t) => t.id)).toEqual([loose.id]);
  });
});

describe('suggestions inbox', () => {
  it('lists unhandled follow-ups, adds them into a milestone, and dismisses with undo', async () => {
    h = await setup({ board: { acceptInto: 'ready' } });
    const m = createMilestone(h.ctx, h.board.id, { title: 'Polish', goal: '' });
    const src = h.newTask({ title: 'Source' });
    const result = { status: 'done', summary: 's', changes: [], testsRun: [], followUps: ['Add caching', ' Write docs ', 'Add caching', 'Fix typo'] };
    h.db.update(tasks).set({ lastResult: result }).where(eq(tasks.id, src.id)).run();

    const texts = () => boardSuggestions(h.ctx, h.board.id).map((s) => s.text);
    expect(texts()).toEqual(['Add caching', 'Write docs', 'Fix typo']);
    expect(boardSuggestions(h.ctx, h.board.id)[0]).toMatchObject({ taskId: src.id, taskNumber: src.number, taskStage: 'backlog' });

    const created = addSuggestions(h.ctx, h.board.id, { items: [{ taskId: src.id, text: 'Add caching' }], milestoneId: m.id });
    expect(created).toHaveLength(1);
    expect(h.task(created[0]!.id)).toMatchObject({ followUpOf: src.id, followUpText: 'Add caching', milestoneId: m.id, stage: 'ready' });
    expect(texts()).toEqual(['Write docs', 'Fix typo']);
    // Adding the same one again is skipped, not an error.
    expect(addSuggestions(h.ctx, h.board.id, { items: [{ taskId: src.id, text: 'Add caching' }], milestoneId: null })).toEqual([]);

    dismissSuggestions(h.ctx, h.board.id, { items: [{ taskId: src.id, text: 'Write docs' }, { taskId: src.id, text: 'Fix typo' }], undo: false });
    expect(texts()).toEqual([]);
    dismissSuggestions(h.ctx, h.board.id, { items: [{ taskId: src.id, text: 'Fix typo' }], undo: true });
    expect(texts()).toEqual(['Fix typo']);

    // Discarding the added task puts its suggestion back in the inbox.
    await runAction(h.ctx, created[0]!.id, 'discard', {});
    expect(texts()).toEqual(['Add caching', 'Fix typo']);

    const other = await setup();
    const foreign = other.newTask({ title: 'Elsewhere' });
    expect(() => addSuggestions(h.ctx, h.board.id, { items: [{ taskId: foreign.id, text: 'x' }], milestoneId: null })).toThrow(/this board/);
    other.cleanup();
  });
});
