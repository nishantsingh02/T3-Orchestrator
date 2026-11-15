// Insights: chats about the board's project. Each chat is one read-only T3 thread on the root checkout.
// A question inserts the user message and a pending answer together with the run that answers it;
// the reconciler fills the answer in (insightProgress while the agent works, finalizeInsight at the end).
import { runOrdinal, type InsightMessageStatus, type RunStatus } from '@t3-orchestra/shared';
import { and, asc, eq, inArray, isNotNull, max, notInArray } from 'drizzle-orm';
import { insightChats, insightMessages, runs, tasks, type BoardRow, type InsightChatRow, type InsightMessageRow, type RunRow } from '../db/schema.ts';
import { boardInsightChats, getInsightChatRow } from '../db/views.ts';
import { childLog } from '../log.ts';
import { isNotFound, type ThreadMessage, type ThreadSummary } from '../t3/T3Client.ts';
import { errorMessage, firstLine, insightMarker, newId, nowIso } from '../util.ts';
import { AppError, emitInsightChat, emitInsightMessage, getBoardOrThrow, type EngineContext } from './context.ts';
import { milestonesText } from './plans.ts';
import { finishRun, insertRun, launchRun, modelFor, requireHealthy } from './runs.ts';
import { knowledgeFor } from '../knowledge/service.ts';

const log = childLog('insights');

const OPEN: InsightMessageStatus[] = ['pending', 'waiting'];
const MAX_OPEN_TASKS = 80;
/** A chat whose thread is gone continues in a new thread that gets this much of the conversation. */
const HISTORY_MESSAGES = 12;
const HISTORY_CHARS = 4000;

function getChatOrThrow(ctx: EngineContext, id: string): InsightChatRow {
  const c = getInsightChatRow(ctx.db, id);
  if (!c) throw new AppError('NOT_FOUND', `chat ${id} not found`, 404);
  return c;
}

function messagesOf(ctx: EngineContext, chatId: string): InsightMessageRow[] {
  return ctx.db.select().from(insightMessages).where(eq(insightMessages.chatId, chatId)).orderBy(asc(insightMessages.seq)).all();
}

/** The answer a run fills in (none when the chat was deleted meanwhile). */
export function answerOfRun(ctx: EngineContext, runId: string): InsightMessageRow | undefined {
  return ctx.db.select().from(insightMessages).where(eq(insightMessages.runId, runId)).get();
}

/** The board's tasks that aren't done or discarded, one line each ("(none)" when there are none). */
export function openTasksText(ctx: EngineContext, boardId: string): string {
  const rows = ctx.db
    .select({ number: tasks.number, title: tasks.title, stage: tasks.stage })
    .from(tasks)
    .where(and(eq(tasks.boardId, boardId), notInArray(tasks.stage, ['done', 'discarded'])))
    .orderBy(asc(tasks.number))
    .all();
  if (rows.length === 0) return '(none)';
  const lines = rows.slice(0, MAX_OPEN_TASKS).map((t) => `- #${t.number} ${t.title} (${t.stage.replace('_', ' ')})`);
  if (rows.length > MAX_OPEN_TASKS) lines.push(`- … and ${rows.length - MAX_OPEN_TASKS} more`);
  return lines.join('\n');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function historyText(msgs: InsightMessageRow[]): string {
  return msgs
    .filter((m) => m.role === 'user' || (m.status === 'done' && m.text.trim()))
    .slice(-HISTORY_MESSAGES)
    .map((m) => `${m.role === 'user' ? '**User:**' : '**You:**'} ${clip(m.text.trim(), HISTORY_CHARS)}`)
    .join('\n\n');
}

function firstPrompt(ctx: EngineContext, board: BoardRow, question: string, earlier: InsightMessageRow[]): string {
  return ctx.prompts.render('insight', {
    projectPath: board.projectPath,
    baseBranch: board.baseBranch,
    boardBrief: board.brief.trim() || '(empty)',
    milestones: milestonesText(ctx, board.id),
    openTasks: openTasksText(ctx, board.id),
    history: historyText(earlier),
    knowledge: knowledgeFor(ctx, board, { text: question }, 'question'),
    question,
  });
}

export function listChats(ctx: EngineContext, boardId: string) {
  return boardInsightChats(ctx.db, boardId);
}

export async function createChat(ctx: EngineContext, boardId: string, text: string): Promise<InsightChatRow> {
  requireHealthy(ctx);
  getBoardOrThrow(ctx, boardId);
  const now = nowIso();
  let chat!: InsightChatRow;
  ctx.db.transaction((tx) => {
    const top = tx.select({ n: max(insightChats.number) }).from(insightChats).where(eq(insightChats.boardId, boardId)).get();
    const number = (top?.n ?? 0) + 1;
    chat = {
      id: newId(),
      boardId,
      number,
      title: firstLine(text, 80) || `Chat ${number}`,
      threadId: null,
      threadLink: null,
      lastT3RunId: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(insightChats).values(chat).run();
  });
  await ask(ctx, chat, text);
  return getChatOrThrow(ctx, chat.id);
}

export async function sendChatMessage(ctx: EngineContext, chatId: string, text: string): Promise<InsightChatRow> {
  requireHealthy(ctx);
  const chat = getChatOrThrow(ctx, chatId);
  const busy = ctx.db
    .select({ id: insightMessages.id })
    .from(insightMessages)
    .where(and(eq(insightMessages.chatId, chatId), inArray(insightMessages.status, OPEN)))
    .get();
  if (busy) throw new AppError('ILLEGAL_TRANSITION', 'The agent is still answering the last question.', 409);
  await ask(ctx, chat, text);
  return getChatOrThrow(ctx, chatId);
}

/** Sends the question to the chat's thread, or starts one (first question, or the old thread is gone). */
async function ask(ctx: EngineContext, chat: InsightChatRow, text: string): Promise<void> {
  const board = getBoardOrThrow(ctx, chat.boardId);
  const earlier = messagesOf(ctx, chat.id);
  let threadId = chat.threadId;
  let baseline: string | null = null;
  if (threadId) {
    try {
      baseline = (await ctx.t3.show(threadId, { messages: 1 })).thread.latestRunId;
    } catch (err) {
      if (!isNotFound(err)) throw new AppError('T3_UNAVAILABLE', `Could not read the chat's T3 thread: ${errorMessage(err)}`, 503);
      log.info({ chatId: chat.id, threadId }, 'chat thread is gone; continuing in a new thread');
      threadId = null;
    }
  }
  const { provider, model } = modelFor(board, null, 'insight');
  const marker = insightMarker(board.short, chat.number);
  let runId = '';
  const ids = { question: newId(), answer: newId() };
  ctx.db.transaction((tx) => {
    const now = nowIso();
    const top = tx.select({ s: max(insightMessages.seq) }).from(insightMessages).where(eq(insightMessages.chatId, chat.id)).get();
    const seq = (top?.s ?? 0) + 1;
    runId = insertRun(
      tx,
      threadId
        ? { boardId: board.id, kind: 'insight', threadRole: 'insight', promptText: text, threadId, threadLink: chat.threadLink, baselineRunId: baseline }
        : {
            boardId: board.id,
            kind: 'insight',
            threadRole: 'insight',
            promptText: firstPrompt(ctx, board, text, earlier),
            marker,
            launch: { project: board.projectPath, title: `Insights #${chat.number}: ${chat.title} ${marker}`, provider, model },
          },
    ).id;
    const base = { chatId: chat.id, boardId: board.id, notes: [], error: null, createdAt: now };
    tx.insert(insightMessages).values({ ...base, id: ids.question, seq, role: 'user', text, status: 'done', runId: null, finishedAt: now }).run();
    tx.insert(insightMessages).values({ ...base, id: ids.answer, seq: seq + 1, role: 'assistant', text: '', status: 'pending', runId, finishedAt: null }).run();
    tx.update(insightChats)
      .set(threadId ? { updatedAt: now } : { threadId: null, threadLink: null, updatedAt: now })
      .where(eq(insightChats.id, chat.id))
      .run();
  });
  emitInsightMessage(ctx, ids.question);
  emitInsightMessage(ctx, ids.answer);
  await launchRun(ctx, runId);
  // The reconciler may be on its idle interval: have it switch to the active one now.
  ctx.kick();
}

export function renameChat(ctx: EngineContext, chatId: string, title: string): InsightChatRow {
  getChatOrThrow(ctx, chatId);
  ctx.db.update(insightChats).set({ title, updatedAt: nowIso() }).where(eq(insightChats.id, chatId)).run();
  emitInsightChat(ctx, chatId);
  return getChatOrThrow(ctx, chatId);
}

/** Removes the chat from T3 Orchestra; its T3 thread is settled (when the app settles done threads) but kept. */
export function deleteChat(ctx: EngineContext, chatId: string): void {
  const chat = getChatOrThrow(ctx, chatId);
  const answering = messagesOf(ctx, chatId).some((m) => OPEN.includes(m.status));
  ctx.db.transaction((tx) => {
    tx.delete(insightMessages).where(eq(insightMessages.chatId, chatId)).run();
    tx.delete(insightChats).where(eq(insightChats.id, chatId)).run();
  });
  ctx.bus.emit('insight_chat_removed', { id: chat.id, boardId: chat.boardId });
  if (chat.threadId && !answering && ctx.settings.get().settleDoneThreads) {
    void ctx.t3
      .settleThreads([chat.threadId])
      .catch((err) => log.warn({ chatId, err: errorMessage(err) }, 'could not settle the chat thread'));
  }
}

// ---------------------------------------------------------------------------
// Run lifecycle (called by runs.ts and the reconciler)
// ---------------------------------------------------------------------------

/** The agent's messages so far in this turn, shown under the pending answer. */
export function insightProgress(ctx: EngineContext, run: RunRow, texts: string[]): void {
  const answer = answerOfRun(ctx, run.id);
  if (!answer || !OPEN.includes(answer.status)) return;
  const notes = texts.map((t) => t.trim()).filter(Boolean);
  if (notes.length === 0 || JSON.stringify(notes) === JSON.stringify(answer.notes)) return;
  ctx.db.update(insightMessages).set({ notes }).where(eq(insightMessages.id, answer.id)).run();
  emitInsightMessage(ctx, answer.id);
}

/** `waiting` while the agent waits for the user in T3 (it was told not to ask, but may). */
export function insightAttention(ctx: EngineContext, run: RunRow, waiting: boolean): void {
  const answer = answerOfRun(ctx, run.id);
  if (!answer || !OPEN.includes(answer.status)) return;
  const status: InsightMessageStatus = waiting ? 'waiting' : 'pending';
  if (answer.status === status) return;
  ctx.db.update(insightMessages).set({ status }).where(eq(insightMessages.id, answer.id)).run();
  emitInsightMessage(ctx, answer.id);
}

/**
 * Fills the answer in from the run's assistant messages: the last one is the answer, the rest are notes.
 * `seenRunId`: the thread's last T3 run this answer covers; later runs are picked up by syncChatRuns.
 */
export function finalizeInsight(
  ctx: EngineContext,
  run: RunRow,
  o: { texts: string[]; runStatus: RunStatus; threadStatus: string; seenRunId: string | null },
): void {
  const answer = answerOfRun(ctx, run.id);
  const texts = o.texts.map((t) => t.trim()).filter(Boolean);
  const final = texts.at(-1) ?? '';
  const bad = o.runStatus !== 'completed';
  const error = bad ? `The agent's run ended ${o.threadStatus.replace('_', ' ')}.` : final ? null : 'The agent finished without replying.';
  const now = nowIso();
  ctx.db.transaction((tx) => {
    finishRun(tx, run.id, { status: o.runStatus, resultRaw: final || null, error: bad ? error : null });
    if (!answer) return;
    tx.update(insightMessages)
      .set({ text: final, notes: texts.slice(0, -1), status: error ? 'failed' : 'done', error, finishedAt: now })
      .where(eq(insightMessages.id, answer.id))
      .run();
    tx.update(insightChats)
      .set({ updatedAt: now, ...(o.seenRunId ? { lastT3RunId: o.seenRunId } : {}) })
      .where(eq(insightChats.id, answer.chatId))
      .run();
  });
  if (answer) emitInsightMessage(ctx, answer.id);
}

// ---------------------------------------------------------------------------
// Runs nobody here started: the agent going on by itself (its background work came back and it
// resumes the thread), or the user asking in T3 directly
// ---------------------------------------------------------------------------

/** Highest T3 run ordinal of the chat's thread that its answers already cover. */
function knownOrdinal(ctx: EngineContext, chat: InsightChatRow): number {
  const ords = ctx.db
    .select({ t3RunId: runs.t3RunId })
    .from(runs)
    .where(and(eq(runs.threadId, chat.threadId!), eq(runs.threadRole, 'insight')))
    .all()
    .map((r) => runOrdinal(r.t3RunId) ?? 0);
  return Math.max(runOrdinal(chat.lastT3RunId) ?? 0, ...ords);
}

/** The board's chats whose thread has runs past what their answers cover, with nothing being answered. */
export function chatsToSync(ctx: EngineContext, boardId: string, summaries: Map<string, ThreadSummary>) {
  const chats = ctx.db
    .select()
    .from(insightChats)
    .where(and(eq(insightChats.boardId, boardId), isNotNull(insightChats.threadId)))
    .all();
  const out: Array<{ chat: InsightChatRow; known: number }> = [];
  for (const chat of chats) {
    const latest = runOrdinal(summaries.get(chat.threadId!)?.latestRunId);
    if (latest === null) continue;
    const answering = ctx.db
      .select({ id: insightMessages.id })
      .from(insightMessages)
      .where(and(eq(insightMessages.chatId, chat.id), inArray(insightMessages.status, OPEN)))
      .get();
    if (answering) continue;
    const known = knownOrdinal(ctx, chat);
    if (latest > known) out.push({ chat, known });
  }
  return out;
}

/**
 * Adopts the thread's runs past `known` as active runs, so the reconciler fills them in: runs before the
 * first new question continue the chat's last answer (reopened), and each question asked in T3 gets a
 * question and an answer here. Returns the new run ids.
 */
export function adoptChatRuns(ctx: EngineContext, chat: InsightChatRow, known: number, latestRunId: string, messages: ThreadMessage[]): string[] {
  const asked = messages.filter((m) => m.role === 'user' && (runOrdinal(m.runId) ?? 0) > known);
  const firstAsked = asked.length ? (runOrdinal(asked[0]!.runId) ?? Infinity) : Infinity;
  const continued = (runOrdinal(latestRunId) ?? 0) > known && firstAsked > known + 1;
  const msgs = messagesOf(ctx, chat.id);
  const answer = msgs.findLast((m) => m.role === 'assistant');
  const from = answer?.runId ? ctx.db.select().from(runs).where(eq(runs.id, answer.runId)).get() : undefined;
  const runIds: string[] = [];
  const touched: string[] = [];
  const now = nowIso();
  const thread = { threadId: chat.threadId!, threadLink: chat.threadLink };
  ctx.db.transaction((tx) => {
    if (continued && answer && from) {
      // Collects from the same question as before, so the answer is rebuilt from all of its runs.
      const runId = insertRun(tx, {
        boardId: chat.boardId,
        kind: 'insight',
        threadRole: 'insight',
        promptText: '(the agent went on by itself)',
        ...thread,
        baselineRunId: from.baselineRunId,
        adopted: { t3RunId: from.t3RunId },
      }).id;
      tx.update(insightMessages)
        .set({ status: 'pending', runId, text: '', notes: [...answer.notes, answer.text].filter((t) => t.trim()), error: null, finishedAt: null })
        .where(eq(insightMessages.id, answer.id))
        .run();
      runIds.push(runId);
      touched.push(answer.id);
    }
    let seq = msgs.at(-1)?.seq ?? 0;
    for (const q of asked) {
      const runId = insertRun(tx, {
        boardId: chat.boardId,
        kind: 'insight',
        threadRole: 'insight',
        promptText: q.text,
        ...thread,
        adopted: { t3RunId: q.runId },
      }).id;
      const ids = { question: newId(), answer: newId() };
      const base = { chatId: chat.id, boardId: chat.boardId, notes: [], error: null, createdAt: now };
      tx.insert(insightMessages).values({ ...base, id: ids.question, seq: ++seq, role: 'user', text: q.text, status: 'done', runId: null, finishedAt: now }).run();
      tx.insert(insightMessages).values({ ...base, id: ids.answer, seq: ++seq, role: 'assistant', text: '', status: 'pending', runId, finishedAt: null }).run();
      runIds.push(runId);
      touched.push(ids.question, ids.answer);
    }
    if (runIds.length) tx.update(insightChats).set({ updatedAt: now }).where(eq(insightChats.id, chat.id)).run();
  });
  if (runIds.length) log.info({ chatId: chat.id, continued, asked: asked.length }, 'picked up chat runs started outside T3 Orchestra');
  for (const id of touched) emitInsightMessage(ctx, id);
  return runIds;
}
