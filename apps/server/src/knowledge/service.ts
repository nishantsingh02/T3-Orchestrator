// Context view backend: the board's context files (upload, replace, remove), its knowledge graph, the
// views the page shows, and the knowledge section every agent prompt gets. The project folder
// (.t3orchestra/context) holds the files and graph.json; the database keeps a copy in step with it.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  knowledgeFileKind,
  MAX_KNOWLEDGE_DESCRIPTION,
  MAX_KNOWLEDGE_FILE_BYTES,
  MAX_KNOWLEDGE_FILE_MB,
  MAX_KNOWLEDGE_FILES,
  type BoardKnowledgeView,
  type KnowledgeBuildStatus,
  type KnowledgeBuildView,
  type KnowledgeFileView,
  type KnowledgeGraph,
} from '@t3-orchestra/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { contextBuilds, contextFiles, contextGraphs, type BoardRow, type ContextBuildRow, type ContextFileRow } from '../db/schema.ts';
import { AppError, getBoardOrThrow, type DbOrTx, type EngineContext } from '../engine/context.ts';
import { childLog } from '../log.ts';
import { errorMessage, newId, nowIso } from '../util.ts';
import {
  contextDir,
  contextFolder,
  contextFilePath,
  legacyContextDir,
  oversizeContextFiles,
  removeContextFile,
  safeFileName,
  scanContextFiles,
  writeContextFile,
} from './files.ts';
import { graphFromManifest, manifestFile, readManifest, toManifest, writeManifest, type ManifestFile } from './folder.ts';
import { dropFiles, type GraphParts } from './graph.ts';
import { knowledgeText, searchText, type Focus, type FocusKind, type TextFile } from './text.ts';

const log = childLog('knowledge');

export const OPEN_BUILD: KnowledgeBuildStatus[] = ['running', 'waiting'];
const SHOWN_BUILDS = 20;

// ---------------------------------------------------------------------------
// Graph storage
// ---------------------------------------------------------------------------

export function loadGraph(db: DbOrTx, boardId: string): KnowledgeGraph {
  const row = db.select().from(contextGraphs).where(eq(contextGraphs.boardId, boardId)).get();
  return row ? { nodes: row.nodes, edges: row.edges, digest: row.digest, updatedAt: row.updatedAt } : { nodes: [], edges: [], digest: '', updatedAt: null };
}

export function saveGraph(tx: DbOrTx, boardId: string, g: GraphParts, digest: string, now: string): void {
  tx.insert(contextGraphs)
    .values({ boardId, nodes: g.nodes, edges: g.edges, digest, updatedAt: now })
    .onConflictDoUpdate({ target: contextGraphs.boardId, set: { nodes: g.nodes, edges: g.edges, digest, updatedAt: now } })
    .run();
}

/** Marks the board's context changed without touching the graph: the graph row's time is the revision graph.json carries. */
export function touchContext(tx: DbOrTx, boardId: string, now: string): void {
  tx.insert(contextGraphs)
    .values({ boardId, nodes: [], edges: [], digest: '', updatedAt: now })
    .onConflictDoUpdate({ target: contextGraphs.boardId, set: { updatedAt: now } })
    .run();
}

// ---------------------------------------------------------------------------
// The project folder
// ---------------------------------------------------------------------------
//
// The folder wins. graph.json carries the revision it was written at; one with another revision came
// from elsewhere (another computer, a pull, a checkout) and replaces the database's graph and file
// list. Files added, changed or deleted in the folder by hand count as uploads and removals. Every
// change made here is written back to the folder.

/** Boards whose graph.json could not be written: the database is ahead until it can be. */
const unsaved = new Set<string>();

/** Writes the database's files and graph to graph.json. Never throws. */
export function saveToProject(ctx: EngineContext, boardId: string): void {
  try {
    const board = getBoardOrThrow(ctx, boardId);
    if (!loadGraph(ctx.db, boardId).updatedAt) touchContext(ctx.db, boardId, nowIso());
    const out = writeManifest(board.projectPath, toManifest(boardFiles(ctx.db, boardId), loadGraph(ctx.db, boardId)));
    // An unreadable graph.json is the user's to sort out; what they keep wins at the next sync.
    if (out === 'skipped') log.warn({ boardId }, 'graph.json in the project could not be read; left as it is');
    unsaved.delete(boardId);
  } catch (err) {
    unsaved.add(boardId);
    log.warn({ boardId, err: errorMessage(err) }, 'could not write the context to the project folder');
  }
}

export interface SyncResult {
  /** The database changed. */
  changed: boolean;
  /** Files are newly waiting to be read. */
  newPending: boolean;
}

const IN_STEP: SyncResult = { changed: false, newPending: false };

/** Brings the database in step with the project folder. Never throws. */
export function syncFromProject(ctx: EngineContext, boardId: string): SyncResult {
  try {
    return sync(ctx, getBoardOrThrow(ctx, boardId));
  } catch (err) {
    log.warn({ boardId, err: errorMessage(err) }, 'could not read the context from the project folder');
    return IN_STEP;
  }
}

function sync(ctx: EngineContext, board: BoardRow): SyncResult {
  const read = readManifest(board.projectPath);
  if (read.kind === 'unreadable') return IN_STEP;
  const disk = scanContextFiles(board.projectPath) ?? [];
  const rows = boardFiles(ctx.db, board.id);
  const g = loadGraph(ctx.db, board.id);

  if (read.kind === 'missing' && disk.length === 0) {
    // An empty folder. Files from before the folder held them move in; otherwise the database's copy
    // stays (the checkout may be on a branch without the folder) until something changes here.
    if (rows.length && moveLegacyFiles(ctx, board, rows)) saveToProject(ctx, board.id);
    return IN_STEP;
  }

  const manifest = read.kind === 'ok' && read.manifest.updatedAt !== g.updatedAt && !unsaved.has(board.id) ? read.manifest : null;
  const baseFiles: ManifestFile[] = manifest ? manifest.files : rows.map(manifestFile);
  const key = (name: string) => name.toLowerCase();
  const byName = new Map(baseFiles.map((f) => [key(f.name), f]));
  const now = nowIso();

  // The folder decides which files there are and what is in them.
  let folderChanged = false;
  const files = disk.map((d): ManifestFile => {
    const known = byName.get(key(d.name));
    if (known && known.sha256 === d.sha256) {
      if (known.name === d.name) return known;
      folderChanged = true;
      return { ...known, name: d.name };
    }
    folderChanged = true;
    // New, or changed by hand: the next build reads it.
    return known
      ? { ...known, name: d.name, size: d.size, sha256: d.sha256, status: 'pending', note: null, updatedAt: now }
      : { name: d.name, size: d.size, sha256: d.sha256, status: 'pending', summary: null, description: null, note: null, uploadedAt: now, updatedAt: now };
  });
  const onDisk = new Set(disk.map((d) => key(d.name)));
  const gone = baseFiles.filter((f) => !onDisk.has(key(f.name)));
  if (gone.length) folderChanged = true;

  if (!manifest && !folderChanged) {
    // In step; a graph.json that is missing or behind is written.
    if (read.kind === 'missing' || unsaved.has(board.id)) saveToProject(ctx, board.id);
    return IN_STEP;
  }

  // Rows keep their ids by name, so builds and graph sources that point at them still do.
  const rowByName = new Map(rows.map((r) => [key(r.name), r]));
  const ids = new Map<string, string>();
  for (const f of [...baseFiles, ...files]) if (!ids.has(key(f.name))) ids.set(key(f.name), rowByName.get(key(f.name))?.id ?? newId());
  const idOf = (name: string) => ids.get(key(name));
  const base = manifest ? { ...graphFromManifest(manifest, idOf), digest: manifest.digest } : g;
  const graph = dropFiles(base, new Set(gone.map((f) => idOf(f.name)!)));

  ctx.db.transaction((tx) => {
    const keep = new Set(files.map((f) => idOf(f.name)!));
    for (const r of rows) if (!keep.has(r.id)) tx.delete(contextFiles).where(eq(contextFiles.id, r.id)).run();
    for (const f of files) {
      const id = idOf(f.name)!;
      const values = {
        name: f.name,
        size: f.size,
        sha256: f.sha256,
        status: f.status,
        summary: f.summary,
        description: f.description,
        note: f.note,
        uploadedAt: f.uploadedAt || now,
        updatedAt: f.updatedAt || now,
      };
      if (rowByName.has(key(f.name))) tx.update(contextFiles).set(values).where(eq(contextFiles.id, id)).run();
      else tx.insert(contextFiles).values({ id, boardId: board.id, ...values }).run();
    }
    // The folder's graph taken as it is keeps its revision; changes found here make a new one.
    saveGraph(tx, board.id, graph, base.digest, folderChanged || !manifest ? now : manifest.updatedAt);
  });
  if (folderChanged) saveToProject(ctx, board.id);
  log.info({ boardId: board.id, fromGraphJson: Boolean(manifest), files: files.length, gone: gone.length }, 'context read from the project folder');
  emitKnowledgeChanged(ctx, board.id);
  const wasPending = new Set(rows.filter((r) => r.status === 'pending').map((r) => r.id));
  return { changed: true, newPending: files.some((f) => f.status === 'pending' && !wasPending.has(idOf(f.name)!)) };
}

/** Files uploaded before the project folder held them move in. True when there were any. */
function moveLegacyFiles(ctx: EngineContext, board: BoardRow, rows: readonly ContextFileRow[]): boolean {
  const old = legacyContextDir(ctx.config.dataDir, board.id);
  if (!fs.existsSync(old)) return false;
  for (const r of rows) {
    const from = path.join(old, r.name);
    if (fs.existsSync(from)) writeContextFile(board.projectPath, r.name, fs.readFileSync(from), r.sha256);
  }
  fs.rmSync(old, { recursive: true, force: true });
  log.info({ boardId: board.id, files: rows.length }, 'moved the context files into the project folder');
  return true;
}

function folderProblem(boardId: string, projectPath: string): string | null {
  const problems: string[] = [];
  const read = readManifest(projectPath);
  if (read.kind === 'unreadable') {
    problems.push(`${contextFolder(projectPath)}/graph.json can't be read: ${read.reason}. The board works from its own copy and leaves the file alone until it can be read again.`);
  } else if (unsaved.has(boardId)) {
    problems.push(`The board couldn't write to ${contextFolder(projectPath)} in the project. It tries again with the next change.`);
  }
  // Put there by hand: the scan skips them, so they would quietly be missing from the graph.
  const big = oversizeContextFiles(projectPath);
  if (big.length > 0) {
    const names = big.length === 1 ? big[0]! : `${big.slice(0, -1).join(', ')} and ${big.at(-1)!}`;
    problems.push(`${names} ${big.length === 1 ? 'is' : 'are'} over ${MAX_KNOWLEDGE_FILE_MB} MB, so the board leaves ${big.length === 1 ? 'it' : 'them'} out of the graph.`);
  }
  return problems.length > 0 ? problems.join(' ') : null;
}

// ---------------------------------------------------------------------------
// Views and SSE
// ---------------------------------------------------------------------------

export function boardFiles(db: DbOrTx, boardId: string): ContextFileRow[] {
  return db.select().from(contextFiles).where(eq(contextFiles.boardId, boardId)).all();
}

export function openBuild(db: DbOrTx, boardId: string): ContextBuildRow | undefined {
  return db
    .select()
    .from(contextBuilds)
    .where(and(eq(contextBuilds.boardId, boardId), inArray(contextBuilds.status, OPEN_BUILD)))
    .get();
}

function fileViewOf(row: ContextFileRow, projectPath: string, reading: ReadonlySet<string>, cites: ReadonlyMap<string, number>): KnowledgeFileView {
  return {
    id: row.id,
    boardId: row.boardId,
    name: row.name,
    size: row.size,
    kind: knowledgeFileKind(row.name),
    status: row.status,
    summary: row.summary,
    description: row.description,
    note: row.note,
    reading: reading.has(row.id),
    nodeCount: cites.get(row.id) ?? 0,
    path: contextFilePath(projectPath, row.name),
    // The hash in the URL gives a replaced file a new URL.
    url: `/api/context/files/${row.id}/raw?v=${row.sha256.slice(0, 12)}`,
    uploadedAt: row.uploadedAt,
    updatedAt: row.updatedAt,
  };
}

/** Nodes citing each file. */
function citations(g: GraphParts): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of g.nodes) for (const id of new Set(n.sources.map((s) => s.fileId))) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

export function knowledgeBuildView(row: ContextBuildRow): KnowledgeBuildView {
  return {
    id: row.id,
    boardId: row.boardId,
    number: row.number,
    status: row.status,
    fresh: row.fresh,
    fileNames: row.files.map((f) => f.name),
    threadLink: row.threadLink,
    summary: row.summary,
    stats: row.stats ?? null,
    error: row.error,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

export function fileViews(ctx: EngineContext, boardId: string, g: GraphParts = loadGraph(ctx.db, boardId)): KnowledgeFileView[] {
  const { projectPath } = getBoardOrThrow(ctx, boardId);
  const reading = new Set(openBuild(ctx.db, boardId)?.files.map((f) => f.id) ?? []);
  const cites = citations(g);
  return boardFiles(ctx.db, boardId)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || a.name.localeCompare(b.name))
    .map((r) => fileViewOf(r, projectPath, reading, cites));
}

/** The page's data, as the database has it (the route syncs with the folder first). `git` is filled in by the route. */
export function boardKnowledge(ctx: EngineContext, boardId: string): BoardKnowledgeView {
  const { projectPath } = getBoardOrThrow(ctx, boardId);
  const graph = loadGraph(ctx.db, boardId);
  const builds = ctx.db
    .select()
    .from(contextBuilds)
    .where(eq(contextBuilds.boardId, boardId))
    .orderBy(desc(contextBuilds.number))
    .limit(SHOWN_BUILDS)
    .all();
  return {
    boardId,
    files: fileViews(ctx, boardId, graph),
    builds: builds.map(knowledgeBuildView),
    graph,
    dir: contextDir(projectPath),
    folder: contextFolder(projectPath),
    folderProblem: folderProblem(boardId, projectPath),
    git: null,
  };
}

export function emitKnowledgeBuild(ctx: EngineContext, buildId: string): void {
  const b = ctx.db.select().from(contextBuilds).where(eq(contextBuilds.id, buildId)).get();
  if (b) ctx.bus.emit('knowledge_build', knowledgeBuildView(b));
}

export function emitKnowledgeChanged(ctx: EngineContext, boardId: string): void {
  ctx.bus.emit('knowledge_changed', { boardId });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function getFileOrThrow(ctx: EngineContext, id: string): ContextFileRow {
  const f = ctx.db.select().from(contextFiles).where(eq(contextFiles.id, id)).get();
  if (!f) throw new AppError('NOT_FOUND', `context file ${id} not found`, 404);
  return f;
}

/** A file another program holds open (Windows) can't be replaced or deleted: say so instead of a 500. */
function onDisk<T>(name: string, what: 'save' | 'delete', fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new AppError('VALIDATION', `Could not ${what} ${name} in the project folder (${errorMessage(err)}). If another program has it open, close it and try again.`, 409);
  }
}

/** A description as it is kept: trimmed, null when empty. */
function cleanDescription(text: string | null): string | null {
  const t = (text ?? '').replace(/\r\n?/g, '\n').trim();
  if (t.length > MAX_KNOWLEDGE_DESCRIPTION) throw new AppError('VALIDATION', `A description can be at most ${MAX_KNOWLEDGE_DESCRIPTION} characters.`);
  return t || null;
}

/**
 * Saves an uploaded file. A file with the same name (in any case) is replaced; when its content
 * changed it goes back to `pending`, so the next build reads it again. `description` (what the user
 * says the file is) stays as it was when left out; a different one also has the file read again.
 */
export function addFile(ctx: EngineContext, boardId: string, rawName: string, data: Uint8Array, rawDescription?: string | null): KnowledgeFileView {
  const board = getBoardOrThrow(ctx, boardId);
  const name = safeFileName(rawName);
  if (!name) throw new AppError('VALIDATION', 'The file needs a name.');
  if (data.byteLength === 0) throw new AppError('VALIDATION', `${name} is empty.`);
  if (data.byteLength > MAX_KNOWLEDGE_FILE_BYTES) {
    throw new AppError('VALIDATION', `${name} is larger than ${MAX_KNOWLEDGE_FILE_MB} MB.`, 413);
  }
  const given = rawDescription === undefined ? undefined : cleanDescription(rawDescription);
  syncFromProject(ctx, boardId);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const files = boardFiles(ctx.db, boardId);
  const existing = files.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (!existing && files.length >= MAX_KNOWLEDGE_FILES) throw new AppError('VALIDATION', `A board holds at most ${MAX_KNOWLEDGE_FILES} context files.`, 409);

  const now = nowIso();
  const id = existing?.id ?? newId();
  const description = given === undefined ? (existing?.description ?? null) : given;
  const sameFile = existing && existing.sha256 === sha256 && existing.name === name;
  // The same file again, described the same, has nothing to do.
  if (!sameFile || existing.description !== description) {
    if (!sameFile) {
      onDisk(name, 'save', () => {
        // Same name in another case: on Windows that is the same file on disk, so the old one goes first.
        if (existing && existing.name !== name) removeContextFile(board.projectPath, existing.name);
        writeContextFile(board.projectPath, name, data, sha256);
      });
    }
    ctx.db.transaction((tx) => {
      if (existing) {
        const reread = existing.sha256 !== sha256 || existing.description !== description;
        tx.update(contextFiles)
          .set({
            name,
            size: data.byteLength,
            sha256,
            description,
            status: reread ? 'pending' : existing.status,
            note: reread ? null : existing.note,
            updatedAt: now,
          })
          .where(eq(contextFiles.id, existing.id))
          .run();
      } else {
        tx.insert(contextFiles)
          .values({ id, boardId, name, size: data.byteLength, sha256, status: 'pending', summary: null, description, note: null, uploadedAt: now, updatedAt: now })
          .run();
      }
      touchContext(tx, boardId, now);
    });
    saveToProject(ctx, boardId);
    log.info({ boardId, name, bytes: data.byteLength, replaced: Boolean(existing) }, 'context file saved');
    emitKnowledgeChanged(ctx, boardId);
  }
  return fileViews(ctx, boardId).find((f) => f.id === id)!;
}

/**
 * Sets what the user says the file is. With `reread`, a file already read (into the graph, or
 * skipped) goes back to `pending`, so the next build reads it with the new description. A file a
 * build is reading right now stays pending when that build finishes (see finalizeKnowledge).
 */
export function describeFile(ctx: EngineContext, id: string, body: { description: string | null; reread: boolean }): KnowledgeFileView {
  const boardId = getFileOrThrow(ctx, id).boardId;
  const description = cleanDescription(body.description);
  syncFromProject(ctx, boardId);
  const f = getFileOrThrow(ctx, id);
  const changed = f.description !== description;
  // A skipped file is worth another try even with the same description.
  const reread = body.reread && f.status !== 'pending' && (changed || f.status === 'skipped');
  if (changed || reread) {
    const now = nowIso();
    ctx.db.transaction((tx) => {
      tx.update(contextFiles)
        .set(reread ? { description, status: 'pending', note: null, updatedAt: now } : { description })
        .where(eq(contextFiles.id, id))
        .run();
      touchContext(tx, boardId, now);
    });
    saveToProject(ctx, boardId);
    log.info({ boardId, name: f.name, reread }, 'context file described');
    emitKnowledgeChanged(ctx, boardId);
  }
  return fileViews(ctx, boardId).find((v) => v.id === id)!;
}

/** Deletes the file and takes what it said out of the graph. */
export function removeFile(ctx: EngineContext, id: string): void {
  const boardId = getFileOrThrow(ctx, id).boardId;
  syncFromProject(ctx, boardId);
  const f = ctx.db.select().from(contextFiles).where(eq(contextFiles.id, id)).get();
  if (!f) return; // already gone from the folder: the sync took it out
  // The folder first: a file left there would come back at the next sync.
  onDisk(f.name, 'delete', () => removeContextFile(getBoardOrThrow(ctx, boardId).projectPath, f.name));
  ctx.db.transaction((tx) => {
    tx.delete(contextFiles).where(eq(contextFiles.id, id)).run();
    const g = loadGraph(tx, boardId);
    saveGraph(tx, boardId, dropFiles(g, new Set([id])), g.digest, nowIso());
  });
  saveToProject(ctx, boardId);
  emitKnowledgeChanged(ctx, boardId);
}

// ---------------------------------------------------------------------------
// What agents read
// ---------------------------------------------------------------------------

function textFiles(ctx: EngineContext, boardId: string): TextFile[] {
  const { projectPath } = getBoardOrThrow(ctx, boardId);
  return boardFiles(ctx.db, boardId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => ({ id: f.id, name: f.name, path: contextFilePath(projectPath, f.name), status: f.status, summary: f.summary, description: f.description }));
}

/**
 * The "Project knowledge" section for an agent prompt on this board, or '' when the board has no
 * context or the user turned it off for prompts.
 */
export function knowledgeFor(ctx: EngineContext, board: Pick<BoardRow, 'id' | 'slug' | 'contextInPrompts'>, focus: Focus, kind: FocusKind): string {
  if (!board.contextInPrompts) return '';
  try {
    syncFromProject(ctx, board.id);
    return knowledgeText(loadGraph(ctx.db, board.id), textFiles(ctx, board.id), focus, { kind, mcpBoard: board.slug });
  } catch (err) {
    // A prompt goes out without it rather than not at all.
    log.warn({ boardId: board.id, err: errorMessage(err) }, 'could not build the knowledge section');
    return '';
  }
}

/** The MCP lookup. */
export function searchKnowledge(ctx: EngineContext, boardId: string, query: string, limit?: number): string {
  syncFromProject(ctx, boardId);
  return searchText(loadGraph(ctx.db, boardId), textFiles(ctx, boardId), query, limit);
}
