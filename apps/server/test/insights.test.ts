import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { insightChats, insightMessages, runs } from '../src/db/schema.ts';
import { boardInsightChats, insightChatDetailView } from '../src/db/views.ts';
import { createChat, deleteChat, renameChat, sendChatMessage } from '../src/engine/insights.ts';
import { setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

const chatOf = (id: string) => insightChatDetailView(h.db, h.db.select().from(insightChats).where(eq(insightChats.id, id)).get()!);
const answer = (chatId: string) => chatOf(chatId).messages.at(-1)!;
const threadOf = (chatId: string) => h.db.select().from(insightChats).where(eq(insightChats.id, chatId)).get()!.threadId!;

describe('insights', () => {
  it('starts a read-only thread on the project root and fills the answer in when the run ends', async () => {
    h = await setup();
    h.newTask({ title: 'Add login page' });
    let kicks = 0;
    h.ctx.kick = () => kicks++;
    const chat = await createChat(h.ctx, h.board.id, 'What is the architecture of this project?');
    // The reconciler must switch to its active interval, or progress shows up only every 15s.
    expect(kicks).toBe(1);

    const start = h.fake.calls.find((c) => c.op === 'start')!.args as { title: string; message: string; project: string; worktree?: unknown };
    expect(start.title).toMatch(/^Insights #1: What is the architecture of this project\? \[tb \w+ ask-1\]$/);
    expect(start.project).toBe(h.board.projectPath);
    expect(start.worktree).toBeUndefined();
    expect(start.message).toContain('Do NOT edit, create, or delete files');
    expect(start.message).toContain('#1 Add login page');
    expect(start.message).toMatch(/## Question\s+What is the architecture of this project\?/);

    let view = chatOf(chat.id);
    expect(view.title).toBe('What is the architecture of this project?');
    expect(view.threadLink).toMatch(/fake/);
    expect(view.status).toBe('pending');
    expect(view.messages.map((m) => [m.seq, m.role, m.status])).toEqual([
      [1, 'user', 'done'],
      [2, 'assistant', 'pending'],
    ]);

    const threadId = threadOf(chat.id);
    h.fake.say(threadId, 'Let me look around.');
    await h.tick();
    expect(answer(chat.id).notes).toEqual(['Let me look around.']);

    h.fake.say(threadId, 'Reading the server.');
    h.fake.finishRun(threadId, '## Architecture\nA server and a web app.');
    await h.tick();
    view = chatOf(chat.id);
    expect(view.status).toBe('done');
    expect(view.preview).toBe('## Architecture');
    expect(view.messages.at(-1)).toMatchObject({
      text: '## Architecture\nA server and a web app.',
      notes: ['Let me look around.', 'Reading the server.'],
      status: 'done',
      error: null,
    });
    const run = h.db.select().from(runs).where(eq(runs.kind, 'insight')).get()!;
    expect(run.status).toBe('completed');
  });

  it('sends follow-ups to the same thread as typed, one at a time', async () => {
    h = await setup();
    const chat = await createChat(h.ctx, h.board.id, 'First?');
    const threadId = threadOf(chat.id);
    await expect(sendChatMessage(h.ctx, chat.id, 'Too soon?')).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });

    h.fake.finishRun(threadId, 'One.');
    await h.tick();
    await sendChatMessage(h.ctx, chat.id, 'And the tests?');
    expect(h.fake.calls.filter((c) => c.op === 'send').map((c) => c.args)).toEqual([{ threadId, message: 'And the tests?' }]);
    expect(h.fake.calls.filter((c) => c.op === 'start')).toHaveLength(1);

    h.fake.finishRun(threadId, 'Two.');
    await h.tick();
    expect(chatOf(chat.id).messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'First?'],
      ['assistant', 'One.'],
      ['user', 'And the tests?'],
      ['assistant', 'Two.'],
    ]);
  });

  it('shows when the agent waits for the user in T3, and fails the answer when the run ends badly', async () => {
    h = await setup();
    const chat = await createChat(h.ctx, h.board.id, 'Why?');
    const threadId = threadOf(chat.id);
    h.fake.setStatus(threadId, 'waiting', { pendingRequestCount: 1 });
    await h.tick();
    expect(answer(chat.id).status).toBe('waiting');
    h.fake.setStatus(threadId, 'running', { pendingRequestCount: 0 });
    await h.tick();
    expect(answer(chat.id).status).toBe('pending');

    h.fake.finishRun(threadId, 'Partial', 'interrupted');
    await h.tick();
    expect(answer(chat.id)).toMatchObject({ status: 'failed', text: 'Partial', error: "The agent's run ended interrupted." });
    expect(h.db.select().from(runs).where(eq(runs.kind, 'insight')).get()!.status).toBe('interrupted');
  });

  it('continues in a new thread with the conversation so far when the old thread is gone', async () => {
    h = await setup();
    const chat = await createChat(h.ctx, h.board.id, 'What does it do?');
    const first = threadOf(chat.id);
    h.fake.finishRun(first, 'It tracks tasks.');
    await h.tick();

    h.fake.removeThread(first);
    await sendChatMessage(h.ctx, chat.id, 'And how?');
    const starts = h.fake.calls.filter((c) => c.op === 'start').map((c) => c.args as { message: string });
    expect(starts).toHaveLength(2);
    expect(starts[1]!.message).toMatch(/## Earlier in this conversation\s+\*\*User:\*\* What does it do\?\s+\*\*You:\*\* It tracks tasks\./);
    expect(starts[1]!.message).toMatch(/## Question\s+And how\?/);
    expect(threadOf(chat.id)).not.toBe(first);
  });

  it('fails the answer when its thread disappears mid-run, and unlinks the chat', async () => {
    h = await setup();
    const chat = await createChat(h.ctx, h.board.id, 'Hello?');
    h.fake.removeThread(threadOf(chat.id));
    await h.tick();
    expect(answer(chat.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('no longer exists') });
    expect(h.db.select().from(insightChats).where(eq(insightChats.id, chat.id)).get()!.threadId).toBeNull();
  });

  it('fails the answer when the thread cannot be started', async () => {
    h = await setup();
    h.fake.failNextStart = { afterCreate: false };
    const chat = await createChat(h.ctx, h.board.id, 'Hello?');
    expect(answer(chat.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('could not be started') });
    expect(chatOf(chat.id).status).toBe('failed');
  });

  it('reopens and completes the answer when the agent goes on by itself after its turn ended', async () => {
    h = await setup();
    const chat = await createChat(h.ctx, h.board.id, 'Any security concerns?');
    const threadId = threadOf(chat.id);
    h.fake.say(threadId, 'Starting two background audits.');
    h.fake.finishRun(threadId, "Audits still running; I'll post the findings when they're back.");
    await h.tick();
    expect(answer(chat.id)).toMatchObject({ status: 'done', text: "Audits still running; I'll post the findings when they're back." });

    // T3 resumes the thread on its own: a run with no user message.
    h.fake.agentContinues(threadId);
    h.fake.say(threadId, 'One audit is back.');
    await h.tick();
    expect(answer(chat.id)).toMatchObject({ status: 'pending', text: '' });
    expect(chatOf(chat.id).messages).toHaveLength(2);

    h.fake.finishRun(threadId, 'Still waiting on the second audit.');
    await h.tick();
    h.fake.agentContinues(threadId);
    h.fake.finishRun(threadId, '# Security review\nNo high-severity issue.');
    await h.tick();
    expect(answer(chat.id)).toMatchObject({
      status: 'done',
      text: '# Security review\nNo high-severity issue.',
      notes: [
        'Starting two background audits.',
        "Audits still running; I'll post the findings when they're back.",
        'One audit is back.',
        'Still waiting on the second audit.',
      ],
    });
    expect(chatOf(chat.id).messages).toHaveLength(2);

    // Nothing new in T3: nothing is adopted again.
    const runCount = h.db.select().from(runs).where(eq(runs.kind, 'insight')).all().length;
    await h.tick();
    await h.tick();
    expect(h.db.select().from(runs).where(eq(runs.kind, 'insight')).all()).toHaveLength(runCount);
    expect(answer(chat.id).status).toBe('done');

    // The next question from T3 Orchestra starts a new answer that doesn't take the old messages.
    await sendChatMessage(h.ctx, chat.id, 'Which one first?');
    h.fake.finishRun(threadId, 'The pickle one.');
    await h.tick();
    expect(answer(chat.id)).toMatchObject({ status: 'done', text: 'The pickle one.', notes: [] });
  });

  it('shows questions asked in T3 directly as questions and answers', async () => {
    h = await setup();
    const chat = await createChat(h.ctx, h.board.id, 'What does it do?');
    const threadId = threadOf(chat.id);
    h.fake.finishRun(threadId, 'It tracks tasks.');
    await h.tick();

    h.fake.externalRun(threadId, 'Asked in T3: and the tests?');
    await h.tick();
    expect(chatOf(chat.id).messages.map((m) => [m.role, m.text, m.status])).toEqual([
      ['user', 'What does it do?', 'done'],
      ['assistant', 'It tracks tasks.', 'done'],
      ['user', 'Asked in T3: and the tests?', 'done'],
      ['assistant', '', 'pending'],
    ]);
    h.fake.finishRun(threadId, 'Vitest, 200 of them.');
    await h.tick();
    expect(answer(chat.id)).toMatchObject({ status: 'done', text: 'Vitest, 200 of them.' });
    // The first answer stops at the question asked in T3.
    expect(chatOf(chat.id).messages[1]).toMatchObject({ text: 'It tracks tasks.', notes: [] });
  });

  it('lists chats newest first, renames and deletes them (settling the thread)', async () => {
    h = await setup();
    const a = await createChat(h.ctx, h.board.id, 'First chat');
    h.fake.finishRun(threadOf(a.id), 'ok');
    await h.tick();
    const b = await createChat(h.ctx, h.board.id, 'Second chat');
    expect(b.number).toBe(2);
    expect(boardInsightChats(h.db, h.board.id).map((c) => c.title)).toEqual(['Second chat', 'First chat']);

    renameChat(h.ctx, a.id, 'Renamed');
    expect(boardInsightChats(h.db, h.board.id).map((c) => [c.title, c.messageCount])).toEqual([
      ['Renamed', 2],
      ['Second chat', 2],
    ]);

    const threadId = threadOf(a.id);
    deleteChat(h.ctx, a.id);
    expect(h.db.select().from(insightMessages).where(eq(insightMessages.chatId, a.id)).all()).toEqual([]);
    expect(boardInsightChats(h.db, h.board.id).map((c) => c.title)).toEqual(['Second chat']);
    await Promise.resolve();
    expect(h.fake.calls.filter((c) => c.op === 'settle').map((c) => c.args)).toEqual([[threadId]]);
  });
});
