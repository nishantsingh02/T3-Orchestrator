// Knowledge graph builds: a read-only agent on the root checkout reads the board's new or changed
// context files and reports nodes and edges, which T3 Orchestra merges into the board's graph. One T3
// thread per build, one build at a time per board; files go in batches, and a finished build starts
// the next batch while files are left.
import {
  KNOWLEDGE_NODE_TYPE_INFO,
  KNOWLEDGE_NODE_TYPES,
  KNOWLEDGE_RELATIONS,
  type KnowledgeBuildStatus,
  type RunStatus,
} from '@t3-orchestra/shared';
import { eq, max } from 'drizzle-orm';
import { contextBuilds, contextFiles, type BoardRow, type ContextBuildRow, type ContextFileRow, type RunRow } from '../db/schema.ts';
import { contextFilePath } from '../knowledge/files.ts';
import { applyResult, buildStats, degrees, dropFiles, fileResolver } from '../knowledge/graph.ts';
import {
  boardFiles,
  emitKnowledgeBuild,
  emitKnowledgeChanged,
  loadGraph,
  OPEN_BUILD,
  openBuild,
  saveGraph,
  saveToProject,
  syncFromProject,
  touchContext,
} from '../knowledge/service.ts';
import { childLog } from '../log.ts';
import { errorMessage, knowledgeMarker, newId, nowIso } from '../util.ts';
import { addEvent, AppError, getBoardOrThrow, type EngineContext } from './context.ts';
import { parseKnowledgeResult } from './results.ts';
import { buildOfRun, failKnowledgeRun, finishRun, insertRun, launchRun, modelFor, requireHealthy } from './runs.ts';

const log = childLog('knowledge');

/** One build reads at most this many files, or this many bytes (but always one file). */
const BATCH_FILES = 12;
const BATCH_BYTES = 6 * 1024 * 1024;
/** Existing nodes the prompt lists with their summaries; the rest by name only, up to the cap. */
const LIST_WITH_SUMMARY = 150;
const LIST_MAX = 800;

function getBuildOrThrow(ctx: EngineContext, id: string): ContextBuildRow {
  const b = ctx.db.select().from(contextBuilds).where(eq(contextBuilds.id, id)).get();
  if (!b) throw new AppError('NOT_FOUND', `build ${id} not found`, 404);
  return b;
}

/** The oldest pending files first, as many as fit in one build. */
export function pickBatch(pending: readonly ContextFileRow[]): ContextFileRow[] {
  const sorted = [...pending].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.name.localeCompare(b.name));
  const out: ContextFileRow[] = [];
  let bytes = 0;
  for (const f of sorted) {
    if (out.length >= BATCH_FILES || (out.length > 0 && bytes + f.size > BATCH_BYTES)) break;
    out.push(f);
    bytes += f.size;
  }
  return out;
}

/** A user's description under a list item: its lines kept inside the item. */
const indent = (text: string) => text.trim().replace(/\n+/g, '\n  ');

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function buildPrompt(ctx: EngineContext, board: BoardRow, batch: ContextFileRow[], all: ContextFileRow[], fresh: boolean): string {
  const ids = new Set(batch.map((f) => f.id));
  const g = fresh ? { nodes: [], edges: [] } : dropFiles(loadGraph(ctx.db, board.id), ids);
  const deg = degrees(g);
  const nodes = [...g.nodes].sort((a, b) => (deg.get(b.key) ?? 0) - (deg.get(a.key) ?? 0) || a.name.localeCompare(b.name));
  const lines = nodes.slice(0, LIST_MAX).map((n, i) => {
    const head = `- \`${n.key}\` (${n.type}) ${n.name}`;
    return i < LIST_WITH_SUMMARY ? `${head}: ${n.summary}` : head;
  });
  if (nodes.length > LIST_MAX) lines.push(`- … and ${nodes.length - LIST_MAX} more`);
  const others = all.filter((f) => !ids.has(f.id) && f.status === 'indexed');
  const digest = fresh ? '' : loadGraph(ctx.db, board.id).digest.trim();
  return ctx.prompts.render('knowledge', {
    boardName: board.name,
    projectPath: board.projectPath,
    baseBranch: board.baseBranch,
    fileCount: batch.length,
    files: batch.map((f) => ({
      path: contextFilePath(board.projectPath, f.name),
      size: humanSize(f.size),
      reread: !fresh && f.summary !== null,
      description: f.description ? indent(f.description) : '',
    })),
    described: batch.some((f) => f.description),
    hasGraph: g.nodes.length > 0,
    fresh,
    moreFiles: all.length - batch.length,
    nodeCount: g.nodes.length,
    otherFileCount: others.length,
    rereading: !fresh && batch.some((f) => f.summary !== null),
    digest: digest || '(none yet)',
    nodeList: lines.join('\n'),
    otherFiles: others.length
      ? others.map((f) => `- ${f.name}${f.summary ? `: ${f.summary}` : ''}${f.description ? `\n  The user says: ${indent(f.description)}` : ''}`).join('\n')
      : '(none)',
    hasBrief: board.brief.trim() !== '',
    boardBrief: board.brief.trim(),
    typeGuide: KNOWLEDGE_NODE_TYPES.map((t) => `\`${t}\` (${KNOWLEDGE_NODE_TYPE_INFO[t].blurb.replace(/\.$/, '').toLowerCase()})`).join(', '),
    relations: KNOWLEDGE_RELATIONS.map((r) => `\`${r}\``).join(', '),
  });
}

/**
 * Starts a build of the board's pending files. `fresh` reads every file again and replaces the graph
 * (the first batch replaces it, the batches after add to it). One build at a time per board.
 */
export async function startBuild(ctx: EngineContext, boardId: string, o: { fresh?: boolean } = {}): Promise<ContextBuildRow> {
  requireHealthy(ctx);
  const board = getBoardOrThrow(ctx, boardId);
  const busy = openBuild(ctx.db, boardId);
  if (busy) throw new AppError('ILLEGAL_TRANSITION', `Build #${busy.number} is still reading files.`, 409);
  const fresh = Boolean(o.fresh);
  syncFromProject(ctx, boardId);
  let all = boardFiles(ctx.db, boardId);
  if (all.length === 0) throw new AppError('ILLEGAL_TRANSITION', 'Add files first.', 409);
  if (fresh) {
    ctx.db.transaction((tx) => {
      tx.update(contextFiles).set({ status: 'pending' }).where(eq(contextFiles.boardId, boardId)).run();
      touchContext(tx, boardId, nowIso());
    });
    saveToProject(ctx, boardId);
    all = boardFiles(ctx.db, boardId);
  }
  const batch = pickBatch(all.filter((f) => f.status === 'pending'));
  if (batch.length === 0) throw new AppError('ILLEGAL_TRANSITION', 'Every file is already in the graph. Rebuild to read them all again.', 409);

  const promptText = buildPrompt(ctx, board, batch, all, fresh);
  const { provider, model } = modelFor(board, null, 'knowledge');
  const now = nowIso();
  let build!: ContextBuildRow;
  ctx.db.transaction((tx) => {
    const top = tx.select({ n: max(contextBuilds.number) }).from(contextBuilds).where(eq(contextBuilds.boardId, boardId)).get();
    const number = (top?.n ?? 0) + 1;
    const marker = knowledgeMarker(board.short, number);
    const what = batch.length === 1 ? batch[0]!.name : `${batch.length} files`;
    const runId = insertRun(tx, {
      boardId,
      kind: 'knowledge',
      threadRole: 'knowledge',
      promptText,
      marker,
      launch: { project: board.projectPath, title: `Context #${number}: reading ${what} into the knowledge graph ${marker}`, provider, model },
    }).id;
    build = {
      id: newId(),
      boardId,
      number,
      status: 'running',
      fresh,
      files: batch.map((f) => ({ id: f.id, name: f.name, sha256: f.sha256, description: f.description })),
      threadId: null,
      threadLink: null,
      runId,
      correctionSent: false,
      summary: null,
      stats: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    tx.insert(contextBuilds).values(build).run();
  });
  emitKnowledgeBuild(ctx, build.id);
  emitKnowledgeChanged(ctx, boardId);
  log.info({ boardId, build: build.number, files: batch.length, fresh }, 'knowledge build started');
  await launchRun(ctx, build.runId!);
  // The reconciler may be on its idle interval: have it switch to the active one now.
  ctx.kick();
  return getBuildOrThrow(ctx, build.id);
}

/** Starts a build when there is something to read and nothing running. Never throws. */
export async function continueBuilds(ctx: EngineContext, boardId: string, o: { onlyIfAuto: boolean }): Promise<ContextBuildRow | null> {
  try {
    const board = getBoardOrThrow(ctx, boardId);
    if (o.onlyIfAuto && !board.contextAutoBuild) return null;
    if (openBuild(ctx.db, boardId)) return null;
    syncFromProject(ctx, boardId);
    if (!boardFiles(ctx.db, boardId).some((f) => f.status === 'pending')) return null;
    if (!ctx.health.healthy()) return null;
    return await startBuild(ctx, boardId);
  } catch (err) {
    log.warn({ boardId, err: errorMessage(err) }, 'could not start a knowledge build');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Run lifecycle (called by the reconciler)
// ---------------------------------------------------------------------------

/** `waiting` while the agent waits for the user in T3 (it was told not to ask, but may). */
export function knowledgeAttention(ctx: EngineContext, run: RunRow, waiting: boolean): void {
  const build = buildOfRun(ctx, run.id);
  if (!build || !OPEN_BUILD.includes(build.status)) return;
  const status: KnowledgeBuildStatus = waiting ? 'waiting' : 'running';
  if (build.status === status) return;
  ctx.db.update(contextBuilds).set({ status, updatedAt: nowIso() }).where(eq(contextBuilds.id, build.id)).run();
  emitKnowledgeBuild(ctx, build.id);
}

/**
 * Merges the build's result into the graph. An unusable block gets one correction message in the same
 * thread (like audits); a second one fails the build. A finished build starts the next batch.
 */
export async function finalizeKnowledge(
  ctx: EngineContext,
  run: RunRow,
  o: { texts: string[]; runStatus: RunStatus; threadStatus: string; threadId: string; latestRunId: string | null },
): Promise<void> {
  const build = buildOfRun(ctx, run.id);
  if (!build || !OPEN_BUILD.includes(build.status)) return finishRun(ctx.db, run.id, { status: o.runStatus });
  const fail = (error: string, resultRaw: string | null = null) =>
    failKnowledgeRun(ctx, run, (tx) => finishRun(tx, run.id, { status: o.runStatus, resultRaw, error }), error);

  if (o.runStatus !== 'completed') return fail(`The agent's run ended ${o.threadStatus.replace('_', ' ')}.`);

  const parsed = parseKnowledgeResult(o.texts);
  if (parsed.ok) {
    // The result goes on top of the graph the folder has now (a pull may have changed it meanwhile).
    syncFromProject(ctx, build.boardId);
    const r = parsed.value;
    const now = nowIso();
    let stats!: ReturnType<typeof buildStats>;
    ctx.db.transaction((tx) => {
      const before = loadGraph(tx, build.boardId);
      const files = boardFiles(tx, build.boardId);
      const ids = new Set(build.files.map((f) => f.id));
      const base = build.fresh ? { nodes: [], edges: [] } : dropFiles(before, ids);
      const { graph, touched } = applyResult(base, r, { files, buildFiles: files.filter((f) => ids.has(f.id)), now });
      stats = buildStats(before, graph, touched);
      saveGraph(tx, build.boardId, graph, r.digest, now);

      const resolve = fileResolver(files);
      const said = new Map(r.files.flatMap((f) => {
        const id = resolve(f.file);
        return id ? [[id, f] as const] : [];
      }));
      for (const read of build.files) {
        const row = files.find((f) => f.id === read.id);
        // Gone, or replaced or described anew while the agent read it: the next build reads it.
        // (Builds started before descriptions existed didn't note one.)
        if (!row || row.sha256 !== read.sha256 || (read.description !== undefined && row.description !== read.description)) continue;
        const info = said.get(row.id);
        tx.update(contextFiles)
          .set({
            status: info?.skipped ? 'skipped' : 'indexed',
            note: info?.skipped ?? null,
            summary: info?.summary || row.summary,
          })
          .where(eq(contextFiles.id, row.id))
          .run();
      }
      finishRun(tx, run.id, { status: 'completed', resultRaw: parsed.raw, resultJson: r });
      tx.update(contextBuilds)
        .set({ status: 'done', summary: r.summary, stats, error: null, finishedAt: now, updatedAt: now })
        .where(eq(contextBuilds.id, build.id))
        .run();
      addEvent(tx, { boardId: build.boardId, runId: run.id, type: 'knowledge_built', payload: { number: build.number, files: build.files.length, ...stats } });
    });
    saveToProject(ctx, build.boardId);
    emitKnowledgeBuild(ctx, build.id);
    emitKnowledgeChanged(ctx, build.boardId);
    log.info({ boardId: build.boardId, build: build.number, ...stats }, 'knowledge graph updated');
    // A finished build has nothing more to say: take its thread out of T3's active sidebar.
    if (ctx.settings.get().settleDoneThreads) {
      void ctx.t3.settleThreads([o.threadId]).catch((err) => log.warn({ buildId: build.id, err: errorMessage(err) }, 'could not settle the build thread'));
    }
    // Files left over (a big upload, or added while this one ran) go in the next build.
    void continueBuilds(ctx, build.boardId, { onlyIfAuto: false });
    return;
  }

  const errors = parsed.errors.join('; ');
  if (build.correctionSent) return fail(`The agent's result was still unusable after one correction: ${errors}`, parsed.raw);

  let correctionRunId = '';
  ctx.db.transaction((tx) => {
    finishRun(tx, run.id, { status: 'completed', resultRaw: parsed.raw, error: errors });
    correctionRunId = insertRun(tx, {
      boardId: build.boardId,
      kind: 'knowledge',
      threadRole: 'knowledge',
      promptText: ctx.prompts.render('knowledge-correction', { errors }),
      threadId: o.threadId,
      threadLink: build.threadLink,
      baselineRunId: o.latestRunId,
    }).id;
    tx.update(contextBuilds).set({ runId: correctionRunId, correctionSent: true, updatedAt: nowIso() }).where(eq(contextBuilds.id, build.id)).run();
  });
  log.info({ buildId: build.id, errors }, 'knowledge result unusable; sent a correction');
  await launchRun(ctx, correctionRunId);
}
