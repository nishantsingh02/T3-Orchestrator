// Imports from T3 Code history: a board made for a project the user already worked on in T3 learns
// what the project is and where it stands. T3 Orchestra collects the project's threads into a digest
// (titles for all, messages for the most relevant), a read-only agent on the root checkout reads it
// and the code, and its result becomes the project context in the board brief, which every later
// prompt includes. A later import replaces that context in the brief.
import { runOrdinal, type ProjectImportStatus, type RunStatus, type T3ProjectView, type ImportResult } from '@t3-orchestra/shared';
import { and, desc, eq, inArray, isNull, max, ne } from 'drizzle-orm';
import path from 'node:path';
import { boards, projectImports, type BoardRow, type ProjectImportRow, type RunRow } from '../db/schema.ts';
import { childLog } from '../log.ts';
import { prStateOf, prUrlOf, type ThreadDetail, type ThreadMessage, type ThreadSummary } from '../t3/T3Client.ts';
import { errorMessage, importMarker, newId, nowIso } from '../util.ts';
import { addEvent, AppError, emitBoard, getBoardOrThrow, type EngineContext } from './context.ts';
import { openTasksText } from './insights.ts';
import { parseImportResult } from './results.ts';
import { failImportRun, finishRun, importOfRun, insertRun, launchRun, modelFor, requireHealthy } from './runs.ts';
import { knowledgeFor } from '../knowledge/service.ts';

const log = childLog('imports');

const OPEN: ProjectImportStatus[] = ['gathering', 'running', 'waiting'];

/** Threads sent with their messages: the ones still open in T3's sidebar first, then the newest. */
const DETAIL_THREADS = 25;
const OPEN_FIRST = 10;
/** Threads after those, listed by title. */
const INDEX_THREADS = 200;
/** Enough of a thread's tail to reach its first ask when it is short. */
const SHOW_MESSAGES = 30;
const SHOW_CONCURRENCY = 4;
const ASK_CHARS = 600;
const LATEST_ASK_CHARS = 400;
const REPLY_CHARS = 1500;

/** T3 Orchestra's own threads that say nothing about the project: AI reviews and earlier imports. */
const NOISE_RE = /\[tb \S+-\d+ r\d+\]|\[tb \S+ import-\d+\]/;

// ---------------------------------------------------------------------------
// Picking and reading the threads
// ---------------------------------------------------------------------------

/** The project's threads worth reading: top-level (no sub-agents), without T3 Orchestra's review and import threads. */
export function historyThreads(summaries: readonly ThreadSummary[]): ThreadSummary[] {
  return summaries.filter((s) => !s.parentThreadId && !NOISE_RE.test(s.title));
}

export interface PickedThreads {
  /** Threads to read with their messages, newest first. */
  detail: ThreadSummary[];
  /** The rest that get a line each, newest first. */
  index: ThreadSummary[];
  total: number;
}

export function pickThreads(summaries: readonly ThreadSummary[]): PickedThreads {
  const all = historyThreads(summaries).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const chosen = new Set(all.filter((t) => t.settled === false).slice(0, OPEN_FIRST));
  for (const t of all) {
    if (chosen.size >= DETAIL_THREADS) break;
    chosen.add(t);
  }
  return {
    detail: all.filter((t) => chosen.has(t)),
    index: all.filter((t) => !chosen.has(t)).slice(0, INDEX_THREADS),
    total: all.length,
  };
}

export interface ReadThread {
  summary: ThreadSummary;
  detail: ThreadDetail;
  messages: ThreadMessage[];
}

/** `show` for each thread, a few at a time. A thread that can't be read falls back to its title. */
async function readThreads(ctx: EngineContext, threads: ThreadSummary[]): Promise<{ read: ReadThread[]; unread: ThreadSummary[] }> {
  const read: Array<ReadThread | null> = new Array(threads.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < threads.length) {
      const i = next++;
      const summary = threads[i]!;
      try {
        const { thread, messages } = await ctx.t3.show(summary.threadId, { messages: SHOW_MESSAGES });
        read[i] = { summary, detail: thread, messages };
      } catch (err) {
        log.warn({ threadId: summary.threadId, err: errorMessage(err) }, 'could not read a thread for the import');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, threads.length) }, worker));
  return { read: read.filter((r): r is ReadThread => r !== null), unread: threads.filter((_, i) => read[i] === null) };
}

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\n{3,}/g, '\n\n');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** As a blockquote, so headings in a message don't break the digest's own. */
const quote = (text: string) => text.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');

const day = (iso: string) => iso.slice(0, 10);

function stateLabel(t: Pick<ThreadSummary, 'status' | 'settled'>): string {
  return `${t.status.replace('_', ' ')}${t.settled === false ? ', still open in T3' : ''}`;
}

/** One thread with its messages. Its branch is named only when it is work apart from the base branch. */
export function threadDigest(t: ReadThread, baseBranch: string): string {
  const { detail, messages } = t;
  const facts = [`last active ${day(detail.updatedAt)}`, stateLabel(detail)];
  if (detail.runCount > 1) facts.push(`${detail.runCount} turns`);
  if (detail.branch && (detail.worktreePath || detail.branch !== baseBranch)) facts.push(`branch \`${detail.branch}\``);
  const pr = prUrlOf(detail);
  if (pr) facts.push(`PR ${pr}${prStateOf(detail) ? ` (${prStateOf(detail)})` : ''}`);
  const asks = messages.filter((m) => m.role === 'user' && m.text.trim());
  const replies = messages.filter((m) => m.role === 'assistant' && m.text.trim());
  // The window holds the thread's start only when its earliest message belongs to the first run.
  const first = asks[0] && runOrdinal(asks[0].runId) === 1 ? asks[0] : null;
  const latest = asks.at(-1);
  const out = [`### ${detail.title || '(untitled)'}`, facts.join(' · ')];
  if (first) out.push(`**Asked:**\n${quote(clip(first.text, ASK_CHARS))}`);
  if (latest && latest !== first) out.push(`**Latest ask:**\n${quote(clip(latest.text, LATEST_ASK_CHARS))}`);
  const reply = replies.at(-1);
  out.push(reply ? `**Last reply:**\n${quote(clip(reply.text, REPLY_CHARS))}` : '_No reply from the agent._');
  return out.join('\n');
}

export function indexLine(t: ThreadSummary): string {
  return `- ${day(t.updatedAt)} · ${t.title || '(untitled)'} · ${stateLabel(t)}`;
}

// ---------------------------------------------------------------------------
// The project context in the brief
// ---------------------------------------------------------------------------

/** The markdown section the import puts into the board brief. */
export function contextText(r: ImportResult, at: string): string {
  const parts = [`## Project context (from T3 Code history, ${day(at)})`, r.about.trim(), `### Where it stands\n${r.state.trim()}`];
  if (r.nextSteps.length) parts.push(`### Next steps\n${r.nextSteps.map((s, i) => `${i + 1}. ${s.trim()}`).join('\n')}`);
  return parts.join('\n\n');
}

/** Puts `text` into the brief: in place of the previous import's context when it is still there, else first. */
export function applyToBrief(brief: string, previous: string | null, text: string): string {
  const b = brief.trim();
  if (!b) return text;
  const prev = previous?.trim();
  if (prev && b.includes(prev)) return b.replace(prev, () => text);
  return `${text}\n\n${b}`;
}

// ---------------------------------------------------------------------------
// T3's projects (for the New board dialog)
// ---------------------------------------------------------------------------

const samePathKey = (p: string) => {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** The projects T3 knows, each with the board already pointing at it (if any). */
export async function listT3Projects(ctx: EngineContext): Promise<T3ProjectView[]> {
  const projects = await ctx.t3.listProjects();
  const rows = ctx.db.select({ slug: boards.slug, projectPath: boards.projectPath, t3ProjectId: boards.t3ProjectId }).from(boards).where(isNull(boards.archivedAt)).all();
  return projects.map((p) => {
    const board = rows.find((b) => b.t3ProjectId === p.id || samePathKey(b.projectPath) === samePathKey(p.path));
    return { ...p, boardSlug: board?.slug ?? null };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function getImportOrThrow(ctx: EngineContext, id: string): ProjectImportRow {
  const i = ctx.db.select().from(projectImports).where(eq(projectImports.id, id)).get();
  if (!i) throw new AppError('NOT_FOUND', `import ${id} not found`, 404);
  return i;
}

function failImport(ctx: EngineContext, importId: string, error: string): void {
  const now = nowIso();
  const imp = getImportOrThrow(ctx, importId);
  ctx.db.update(projectImports).set({ status: 'failed', error, finishedAt: now, updatedAt: now }).where(eq(projectImports.id, importId)).run();
  emitBoard(ctx, imp.boardId);
}

/** Records a new import (`gathering`); `gatherImport` does the rest. One at a time per board. */
export function beginImport(ctx: EngineContext, boardId: string): ProjectImportRow {
  requireHealthy(ctx);
  getBoardOrThrow(ctx, boardId);
  const busy = ctx.db
    .select({ id: projectImports.id })
    .from(projectImports)
    .where(and(eq(projectImports.boardId, boardId), inArray(projectImports.status, OPEN)))
    .get();
  if (busy) throw new AppError('ILLEGAL_TRANSITION', 'This board is already learning about the project from T3.', 409);
  const now = nowIso();
  let row!: ProjectImportRow;
  ctx.db.transaction((tx) => {
    const top = tx.select({ n: max(projectImports.number) }).from(projectImports).where(eq(projectImports.boardId, boardId)).get();
    row = {
      id: newId(),
      boardId,
      number: (top?.n ?? 0) + 1,
      status: 'gathering',
      threadCount: 0,
      threadsRead: 0,
      threadId: null,
      threadLink: null,
      runId: null,
      correctionSent: false,
      summary: null,
      nextSteps: [],
      text: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    tx.insert(projectImports).values(row).run();
  });
  emitBoard(ctx, boardId);
  return row;
}

function importPrompt(ctx: EngineContext, board: BoardRow, picked: PickedThreads, read: ReadThread[], unread: ThreadSummary[]): string {
  const index = [...unread, ...picked.index].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const openTasks = openTasksText(ctx, board.id);
  const earlier = ctx.db
    .select({ id: projectImports.id })
    .from(projectImports)
    .where(and(eq(projectImports.boardId, board.id), eq(projectImports.status, 'done')))
    .get();
  return ctx.prompts.render('import', {
    projectPath: board.projectPath,
    baseBranch: board.baseBranch,
    hasBrief: board.brief.trim() !== '',
    firstImport: !earlier,
    boardBrief: board.brief.trim(),
    hasOpenTasks: openTasks !== '(none)',
    openTasks,
    threadCount: picked.total,
    threadsRead: read.length,
    indexed: index.length,
    unlisted: picked.total - read.length - index.length,
    threadDetails: read.map((t) => threadDigest(t, board.baseBranch)).join('\n\n'),
    threadIndex: index.map(indexLine).join('\n'),
    knowledge: knowledgeFor(ctx, board, { text: '' }, 'work'),
  });
}

/** Collects the threads and starts the agent. Never throws: a failure ends the import as `failed`. */
export async function gatherImport(ctx: EngineContext, importId: string): Promise<void> {
  try {
    const imp = getImportOrThrow(ctx, importId);
    if (imp.status !== 'gathering') return;
    const board = getBoardOrThrow(ctx, imp.boardId);
    let picked: PickedThreads;
    let threads: { read: ReadThread[]; unread: ThreadSummary[] };
    try {
      picked = pickThreads(await ctx.t3.list(board.t3ProjectId ?? board.projectPath));
      threads = await readThreads(ctx, picked.detail);
    } catch (err) {
      return failImport(ctx, importId, `Could not read the project's threads from T3: ${errorMessage(err)}`);
    }
    const promptText = importPrompt(ctx, board, picked, threads.read, threads.unread);
    const { provider, model } = modelFor(board, null, 'import');
    const marker = importMarker(board.short, imp.number);
    let runId = '';
    ctx.db.transaction((tx) => {
      runId = insertRun(tx, {
        boardId: board.id,
        kind: 'import',
        threadRole: 'import',
        promptText,
        marker,
        launch: { project: board.projectPath, title: `Import #${imp.number}: what ${board.name} is and where it stands ${marker}`, provider, model },
      }).id;
      tx.update(projectImports)
        .set({ status: 'running', runId, threadCount: picked.total, threadsRead: threads.read.length, updatedAt: nowIso() })
        .where(eq(projectImports.id, imp.id))
        .run();
    });
    emitBoard(ctx, board.id);
    log.info({ boardId: board.id, threads: picked.total, read: threads.read.length }, 'import started');
    await launchRun(ctx, runId);
    // The reconciler may be on its idle interval: have it switch to the active one now.
    ctx.kick();
  } catch (err) {
    log.error({ importId, err }, 'import failed to start');
    try {
      failImport(ctx, importId, `The import could not be started: ${errorMessage(err)}`);
    } catch {
      /* the import is gone */
    }
  }
}

/** Starts an import and waits until its agent is launched (tests; the HTTP routes don't wait). */
export async function startImport(ctx: EngineContext, boardId: string): Promise<ProjectImportRow> {
  const row = beginImport(ctx, boardId);
  await gatherImport(ctx, row.id);
  return getImportOrThrow(ctx, row.id);
}

/** Imports left `gathering` by a restart start over (at boot). */
export function resumeGathering(ctx: EngineContext): void {
  const rows = ctx.db.select({ id: projectImports.id }).from(projectImports).where(eq(projectImports.status, 'gathering')).all();
  for (const r of rows) void gatherImport(ctx, r.id);
}

// ---------------------------------------------------------------------------
// Run lifecycle (called by the reconciler)
// ---------------------------------------------------------------------------

/** `waiting` while the agent waits for the user in T3 (it was told not to ask, but may). */
export function importAttention(ctx: EngineContext, run: RunRow, waiting: boolean): void {
  const imp = importOfRun(ctx, run.id);
  if (!imp || !OPEN.includes(imp.status)) return;
  const status: ProjectImportStatus = waiting ? 'waiting' : 'running';
  if (imp.status === status) return;
  ctx.db.update(projectImports).set({ status, updatedAt: nowIso() }).where(eq(projectImports.id, imp.id)).run();
  emitBoard(ctx, imp.boardId);
}

/**
 * Writes the result into the board brief. An unusable block gets one correction message in the same
 * thread (like the planner's); a second one fails the import.
 */
export async function finalizeImport(
  ctx: EngineContext,
  run: RunRow,
  o: { texts: string[]; runStatus: RunStatus; threadStatus: string; threadId: string; latestRunId: string | null },
): Promise<void> {
  const imp = importOfRun(ctx, run.id);
  if (!imp || !OPEN.includes(imp.status)) return finishRun(ctx.db, run.id, { status: o.runStatus });
  const fail = (error: string, resultRaw: string | null = null) =>
    failImportRun(ctx, run, (tx) => finishRun(tx, run.id, { status: o.runStatus, resultRaw, error }), error);

  if (o.runStatus !== 'completed') return fail(`The agent's run ended ${o.threadStatus.replace('_', ' ')}.`);

  const parsed = parseImportResult(o.texts);
  if (parsed.ok) {
    const board = getBoardOrThrow(ctx, imp.boardId);
    const now = nowIso();
    const text = contextText(parsed.value, now);
    const previous = ctx.db
      .select({ text: projectImports.text })
      .from(projectImports)
      .where(and(eq(projectImports.boardId, board.id), eq(projectImports.status, 'done'), ne(projectImports.id, imp.id)))
      .orderBy(desc(projectImports.number))
      .get();
    ctx.db.transaction((tx) => {
      finishRun(tx, run.id, { status: 'completed', resultRaw: parsed.raw, resultJson: parsed.value });
      tx.update(boards)
        .set({ brief: applyToBrief(board.brief, previous?.text ?? null, text), updatedAt: now })
        .where(eq(boards.id, board.id))
        .run();
      tx.update(projectImports)
        .set({ status: 'done', summary: parsed.value.summary, nextSteps: parsed.value.nextSteps, text, error: null, finishedAt: now, updatedAt: now })
        .where(eq(projectImports.id, imp.id))
        .run();
      addEvent(tx, { boardId: board.id, runId: run.id, type: 'project_imported', payload: { number: imp.number, threads: imp.threadCount } });
    });
    emitBoard(ctx, board.id);
    log.info({ boardId: board.id, importId: imp.id }, 'project context written to the brief');
    // A finished import has nothing more to say: take its thread out of T3's active sidebar.
    if (ctx.settings.get().settleDoneThreads) {
      void ctx.t3.settleThreads([o.threadId]).catch((err) => log.warn({ importId: imp.id, err: errorMessage(err) }, 'could not settle the import thread'));
    }
    return;
  }

  const errors = parsed.errors.join('; ');
  if (imp.correctionSent) return fail(`The agent's project context was still unusable after one correction: ${errors}`, parsed.raw);

  let correctionRunId = '';
  ctx.db.transaction((tx) => {
    finishRun(tx, run.id, { status: 'completed', resultRaw: parsed.raw, error: errors });
    correctionRunId = insertRun(tx, {
      boardId: imp.boardId,
      kind: 'import',
      threadRole: 'import',
      promptText: ctx.prompts.render('import-correction', { errors }),
      threadId: o.threadId,
      threadLink: imp.threadLink,
      baselineRunId: o.latestRunId,
    }).id;
    tx.update(projectImports).set({ runId: correctionRunId, correctionSent: true, updatedAt: nowIso() }).where(eq(projectImports.id, imp.id)).run();
  });
  log.info({ importId: imp.id, errors }, 'import result unusable; sent a correction');
  await launchRun(ctx, correctionRunId);
}
