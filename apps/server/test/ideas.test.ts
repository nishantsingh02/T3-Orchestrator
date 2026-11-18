import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ideaBatches, runs } from '../src/db/schema.ts';
import { boardIdeas } from '../src/db/views.ts';
import { addIdeaToBoard, dismissIdea, generateIdeas } from '../src/engine/ideas.ts';
import { fence, setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

const idea = (title: string, o: Record<string, unknown> = {}) => ({
  title,
  description: `Why ${title} helps.`,
  details: `Change \`src/${title}.ts\`.`,
  acceptanceCriteria: [`${title} works`],
  touches: [`src/${title}.ts`],
  impact: 'high',
  difficulty: 'easy',
  ...o,
});
const batchOf = (id: string) => h.db.select().from(ideaBatches).where(eq(ideaBatches.id, id)).get()!;
const view = () => boardIdeas(h.db, h.board.id);

describe('ideas', () => {
  it('starts a read-only thread for one category and turns the result block into idea cards', async () => {
    h = await setup();
    h.newTask({ title: 'Add login page' });
    let kicks = 0;
    h.ctx.kick = () => kicks++;
    const batch = await generateIdeas(h.ctx, h.board.id, 'security');
    expect(kicks).toBe(1);

    const start = h.fake.calls.find((c) => c.op === 'start')!.args as { title: string; message: string; project: string; worktree?: unknown };
    expect(start.title).toMatch(/^Ideas #1: Security \[tb \w+ idea-1\]$/);
    expect(start.project).toBe(h.board.projectPath);
    expect(start.worktree).toBeUndefined();
    expect(start.message).toContain('Do NOT edit, create, or delete files');
    expect(start.message).toContain('## Focus: Security');
    expect(start.message).toContain('#1 Add login page');
    expect(view().batches[0]).toMatchObject({ id: batch.id, category: 'security', status: 'generating', threadLink: expect.stringMatching(/fake/) });

    const threadId = batchOf(batch.id).threadId!;
    h.fake.finishRun(threadId, fence({ summary: 'Looked at the API.', ideas: [idea('Rate-limit logins'), idea('Escape search input', { impact: 'medium', difficulty: 'hard' })] }));
    await h.tick();

    const v = view();
    expect(v.batches[0]).toMatchObject({ status: 'done', summary: 'Looked at the API.', ideaCount: 2, error: null });
    expect(v.ideas.map((i) => [i.title, i.category, i.impact, i.difficulty, i.status])).toEqual([
      ['Rate-limit logins', 'security', 'high', 'easy', 'new'],
      ['Escape search input', 'security', 'medium', 'hard', 'new'],
    ]);
    expect(h.db.select().from(runs).where(eq(runs.kind, 'ideas')).get()!.status).toBe('completed');
  });

  it('adds an idea to the board as a Backlog task, once', async () => {
    h = await setup({ board: { acceptInto: 'ready' } });
    const batch = await generateIdeas(h.ctx, h.board.id, 'performance');
    h.fake.finishRun(batchOf(batch.id).threadId!, fence({ ideas: [idea('Cache the summary', { impact: 'low', difficulty: 'hard' })] }));
    await h.tick();
    const [card] = view().ideas;

    const { task } = addIdeaToBoard(h.ctx, card!.id);
    expect(task).toMatchObject({
      stage: 'backlog',
      title: 'Cache the summary',
      category: 'refactor',
      complexity: 'large',
      priority: 'low',
      touches: ['src/Cache the summary.ts'],
      acceptanceCriteria: ['Cache the summary works'],
    });
    expect(task.description).toContain('Why Cache the summary helps.');
    expect(task.description).toContain('Change `src/Cache the summary.ts`.');
    expect(view().ideas[0]).toMatchObject({ status: 'added', taskId: task.id, taskNumber: task.number });
    expect(() => addIdeaToBoard(h.ctx, card!.id)).toThrow(/already #1/);
    expect(() => dismissIdea(h.ctx, card!.id, false)).toThrow(/already on the board/);
  });

  it('dismisses ideas (and brings them back), and tells the next generation what was proposed', async () => {
    h = await setup();
    const first = await generateIdeas(h.ctx, h.board.id, 'documentation');
    h.fake.finishRun(batchOf(first.id).threadId!, fence({ ideas: [idea('Document the env vars'), idea('Write a setup guide')] }));
    await h.tick();
    const [a, b] = view().ideas;
    dismissIdea(h.ctx, a!.id, false);
    expect(view().ideas.map((i) => i.title)).toEqual(['Write a setup guide']);
    dismissIdea(h.ctx, a!.id, true);
    dismissIdea(h.ctx, a!.id, false);
    addIdeaToBoard(h.ctx, b!.id);

    const second = await generateIdeas(h.ctx, h.board.id, 'documentation');
    const message = (h.fake.calls.filter((c) => c.op === 'start').at(-1)!.args as { message: string }).message;
    expect(message).toContain('- Document the env vars (dismissed by the user)');
    expect(message).toContain('- Write a setup guide (on the board as #1)');
    // Repeats of earlier titles are dropped even if the agent proposes them again.
    h.fake.finishRun(batchOf(second.id).threadId!, fence({ ideas: [idea('Write a setup guide'), idea('Add an architecture note')] }));
    await h.tick();
    expect(view().batches[0]).toMatchObject({ number: 2, ideaCount: 1 });
    expect(view().ideas.map((i) => i.title)).toEqual(['Add an architecture note', 'Write a setup guide']);
  });

  it('runs one generation per category at a time', async () => {
    h = await setup();
    await generateIdeas(h.ctx, h.board.id, 'ui_ux');
    await expect(generateIdeas(h.ctx, h.board.id, 'ui_ux')).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    await expect(generateIdeas(h.ctx, h.board.id, 'code_quality')).resolves.toMatchObject({ status: 'generating' });
  });

  it('accepts no ideas, with the summary saying why', async () => {
    h = await setup();
    const batch = await generateIdeas(h.ctx, h.board.id, 'documentation');
    h.fake.finishRun(batchOf(batch.id).threadId!, fence({ summary: 'The docs match the code.', ideas: [] }));
    await h.tick();
    expect(view().batches[0]).toMatchObject({ status: 'done', ideaCount: 0, summary: 'The docs match the code.' });
  });

  it('sends one correction for an unusable result, then fails', async () => {
    h = await setup();
    const batch = await generateIdeas(h.ctx, h.board.id, 'security');
    const threadId = batchOf(batch.id).threadId!;
    h.fake.finishRun(threadId, 'Here are some ideas, no block.');
    await h.tick();
    const sent = h.fake.calls.filter((c) => c.op === 'send').map((c) => c.args as { threadId: string; message: string });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId, message: expect.stringContaining('Your ideas output could not be used') });
    expect(view().batches[0]!.status).toBe('generating');

    h.fake.finishRun(threadId, fence({ ideas: [idea('Oops', { impact: 'huge' })] }));
    await h.tick();
    expect(view().batches[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('still unusable after one correction') });
    expect(view().ideas).toEqual([]);
  });

  it('corrects into a valid result', async () => {
    h = await setup();
    const batch = await generateIdeas(h.ctx, h.board.id, 'security');
    const threadId = batchOf(batch.id).threadId!;
    h.fake.finishRun(threadId, fence({ ideas: [idea('No impact', { impact: undefined })] }));
    await h.tick();
    h.fake.finishRun(threadId, fence({ ideas: [idea('Rate-limit logins')] }));
    await h.tick();
    expect(view().batches[0]).toMatchObject({ status: 'done', ideaCount: 1 });
  });

  it('shows when the agent waits in T3, and fails when the run ends badly or the thread is gone', async () => {
    h = await setup();
    const batch = await generateIdeas(h.ctx, h.board.id, 'performance');
    const threadId = batchOf(batch.id).threadId!;
    h.fake.setStatus(threadId, 'waiting', { pendingRequestCount: 1 });
    await h.tick();
    expect(view().batches[0]!.status).toBe('waiting');
    h.fake.setStatus(threadId, 'running', { pendingRequestCount: 0 });
    await h.tick();
    expect(view().batches[0]!.status).toBe('generating');
    h.fake.finishRun(threadId, 'Partial', 'interrupted');
    await h.tick();
    expect(view().batches[0]).toMatchObject({ status: 'failed', error: "The agent's run ended interrupted." });

    const lost = await generateIdeas(h.ctx, h.board.id, 'performance');
    h.fake.removeThread(batchOf(lost.id).threadId!);
    await h.tick();
    expect(view().batches[0]).toMatchObject({ id: lost.id, status: 'failed', error: expect.stringContaining('no longer exists') });
  });

  it('fails the generation when the thread cannot be started', async () => {
    h = await setup();
    h.fake.failNextStart = { afterCreate: false };
    const batch = await generateIdeas(h.ctx, h.board.id, 'ui_ux');
    expect(batchOf(batch.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('could not be started') });
  });

  it('settles the thread of a finished generation when the app settles done threads', async () => {
    h = await setup();
    h.ctx.settings.patch({ settleDoneThreads: true });
    const batch = await generateIdeas(h.ctx, h.board.id, 'code_quality');
    const threadId = batchOf(batch.id).threadId!;
    h.fake.finishRun(threadId, fence({ ideas: [idea('Split the handler module')] }));
    await h.tick();
    expect(h.fake.calls.filter((c) => c.op === 'settle').map((c) => c.args)).toEqual([[threadId]]);
  });
});
