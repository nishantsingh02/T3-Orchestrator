// Spec-first plans: spec rounds with questions answered in T3 Orchestra, then tasks from the spec.
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PlanFromSpecBody, RefinePlanBody } from '@t3-orchestra/shared';
import { plans, runs } from '../src/db/schema.ts';
import { planDetailView } from '../src/db/views.ts';
import { runAction } from '../src/engine/actions.ts';
import { acceptPlan, createPlan, editSpec, planFromSpec, refineSpec, retryPlan } from '../src/engine/plans.ts';
import { fence, setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

const OPTIONS = { maxTasks: 20, askQuestions: true, extraGuidance: '', specFirst: true };

const specJson = (spec: string, questions: object[] = []) => fence({ spec, changes: '', questions });
const planJson = () =>
  fence({
    summary: 'Split it.',
    tasks: [
      { key: 'T1', title: 'Scaffold', description: 'd', acceptanceCriteria: ['a'], complexity: 'small', category: 'infra' },
      { key: 'T2', title: 'Feature', description: 'd', acceptanceCriteria: ['a'], complexity: 'medium', category: 'feature', dependsOn: ['T1'] },
    ],
  });
const QUESTIONS = [
  { question: 'Who can use it?', why: 'Roles change the tasks.', options: ['Everyone', 'Admins'], recommended: 'Everyone' },
  { question: 'Offline?', options: ['No', 'Yes'] },
];

function planRow(id: string) {
  return h.db.select().from(plans).where(eq(plans.id, id)).get()!;
}
const detail = (id: string) => planDetailView(h.db, planRow(id));
const lastMessage = () => (h.fake.calls.filter((c) => c.op === 'send' || c.op === 'start').at(-1)!.args as { message: string }).message;

/** Finishes the planner thread's current run with `text` and reconciles. */
async function reply(planId: string, text: string) {
  const threadId = planRow(planId).threadId!;
  h.fake.setStatus(threadId, 'running');
  await h.tick();
  h.fake.finishRun(threadId, text);
  await h.tick();
}

describe('spec-first plans', () => {
  it('drafts a spec, takes answers and an edit, then plans tasks that carry the spec', async () => {
    h = await setup();
    const plan = await createPlan(h.ctx, h.board.id, { prompt: 'Build a notes app', options: OPTIONS });
    expect(plan.status).toBe('speccing');
    const first = lastMessage();
    expect(first).toContain('agree on a spec');
    expect(first).toContain('Do NOT use your question tool');
    expect(first).toContain('## GOAL\nBuild a notes app');
    expect(first).not.toContain('"tasks"');
    expect(h.db.select().from(runs).where(eq(runs.planId, plan.id)).all().map((r) => r.kind)).toEqual(['spec']);

    await reply(plan.id, specJson('## Goal\nNotes.', QUESTIONS));
    expect(planRow(plan.id).status).toBe('spec_review');
    let d = detail(plan.id);
    expect(d.spec).toBe('## Goal\nNotes.');
    expect(d.specRounds).toHaveLength(1);
    expect(d.specRounds[0]!.questions[1]).toEqual({ question: 'Offline?', why: '', options: ['No', 'Yes'] });
    expect(h.notifications().some((n) => n.type === 'plan_input' && n.title.startsWith('Planner has 2 questions'))).toBe(true);

    editSpec(h.ctx, plan.id, '## Goal\nNotes, with tags.');
    expect(detail(plan.id).spec).toBe('## Goal\nNotes, with tags.');

    await refineSpec(h.ctx, plan.id, RefinePlanBody.parse({ answers: [{ question: 'Who can use it?', answer: 'Everyone' }], feedback: 'Keep it small.' }));
    expect(planRow(plan.id).status).toBe('speccing');
    const refine = lastMessage();
    expect(refine).toContain('Q: Who can use it?\nA: Everyone');
    expect(refine).toContain('## Questions the user did not answer\n- Offline?');
    expect(refine).toContain('## Note from the user\nKeep it small.');
    expect(refine).toContain("## The user's edit of the spec");
    expect(refine).toContain('Notes, with tags.');
    expect(detail(plan.id).specRounds[0]!.answers).toEqual([{ question: 'Who can use it?', answer: 'Everyone' }]);

    // Unusable reply: one correction on the same step, then a usable round 3 (round 2 holds the errors).
    await reply(plan.id, 'no block');
    expect(lastMessage()).toContain('could not be used');
    expect(h.db.select().from(runs).where(eq(runs.planId, plan.id)).all().map((r) => r.kind)).toEqual(['spec', 'spec', 'spec']);
    await reply(plan.id, specJson('## Goal\nNotes with tags, for everyone.'));
    d = detail(plan.id);
    expect(d.status).toBe('spec_review');
    expect(d.specRounds.map((r) => [r.round, r.validationErrors === null])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
    expect(d.spec).toBe('## Goal\nNotes with tags, for everyone.');

    await planFromSpec(h.ctx, plan.id, PlanFromSpecBody.parse({ answers: [{ question: 'Offline?', answer: 'No' }] }));
    expect(planRow(plan.id).status).toBe('planning');
    const toTasks = lastMessage();
    expect(toTasks).toContain('The user is happy with the spec');
    expect(toTasks).toContain('## The agreed spec\n## Goal\nNotes with tags, for everyone.');
    expect(toTasks).toContain('Q: Offline?\nA: No');
    expect(toTasks).toContain('Max 20 tasks.');
    expect(toTasks).toContain('```t3orchestra-result');

    await reply(plan.id, planJson());
    expect(planRow(plan.id).status).toBe('ready');
    const { tasks: created } = acceptPlan(h.ctx, plan.id);

    await runAction(h.ctx, created[0]!.id, 'start', {});
    const implement = (h.fake.calls.filter((c) => c.op === 'start').at(-1)!.args as { message: string }).message;
    expect(implement).toContain(`### Spec of plan #${plan.number} (agreed with the user)`);
    expect(implement).toContain('Notes with tags, for everyone.');
  });

  it('refuses spec changes while the planner works, and retries from the last good step', async () => {
    h = await setup();
    const plan = await createPlan(h.ctx, h.board.id, { prompt: 'Goal', options: OPTIONS });
    await expect(refineSpec(h.ctx, plan.id, RefinePlanBody.parse({ feedback: 'x' }))).rejects.toThrow(/cannot change while the plan is speccing/);

    // The spec round fails twice: the retry starts the spec from scratch in a fresh thread.
    await reply(plan.id, 'no block');
    await reply(plan.id, 'still no block');
    expect(planRow(plan.id).status).toBe('failed');
    expect(planRow(plan.id).error).toMatch(/spec was still invalid/);
    const firstThread = planRow(plan.id).threadId;
    await retryPlan(h.ctx, plan.id);
    expect(planRow(plan.id).status).toBe('speccing');
    expect(planRow(plan.id).threadId).not.toBe(firstThread);
    expect(lastMessage()).not.toContain('## Spec so far');

    // Tasks from the spec fail twice: the retry plans from the spec in a fresh thread.
    await reply(plan.id, specJson('## Goal\nAgreed.'));
    await planFromSpec(h.ctx, plan.id, PlanFromSpecBody.parse({}));
    await reply(plan.id, 'no block');
    await reply(plan.id, 'no block');
    expect(planRow(plan.id).status).toBe('failed');
    await retryPlan(h.ctx, plan.id);
    expect(planRow(plan.id).status).toBe('planning');
    const retry = lastMessage();
    expect(retry).toContain('## Agreed spec\n## Goal\nAgreed.');
    expect(retry).not.toContain('use your question tool');
    await reply(plan.id, planJson());
    expect(planRow(plan.id).status).toBe('ready');
  });

  it('plans without specFirst go straight to tasks', async () => {
    h = await setup();
    const plan = await createPlan(h.ctx, h.board.id, { prompt: 'Goal', options: { maxTasks: 5, askQuestions: false, extraGuidance: '' } });
    expect(plan.status).toBe('planning');
    const message = lastMessage();
    expect(message).toContain('Max 5 tasks.');
    expect(message).not.toContain('## Agreed spec');
    expect(detail(plan.id).specRounds).toEqual([]);
    expect(detail(plan.id).spec).toBeNull();
  });
});
