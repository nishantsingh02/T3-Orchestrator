// Boards: project validation (spec §5.1), CRUD, export.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_BOARD_SETTINGS, type CreateBoardBody, type PatchBoardBody, type ProjectValidation } from '@t3-orchestra/shared';
import { eq, isNull } from 'drizzle-orm';
import { boards, events, milestones, planSpecRounds, planVersions, plans, reviewFindings, runs, taskDeps, tasks, type BoardRow } from '../db/schema.ts';
import { boardView } from '../db/views.ts';
import * as git from '../git/git.ts';
import { countFiles, protectedFolder } from '../project-setup/folders.ts';
import { errorMessage, newId, nowIso, slugify } from '../util.ts';
import { addEvent, AppError, emitBoard, getBoardOrThrow, type EngineContext } from './context.ts';
import { historyThreads } from './imports.ts';

export async function validateProject(ctx: EngineContext, projectPath: string, baseBranch?: string | null): Promise<ProjectValidation> {
  const v: ProjectValidation = {
    ok: false,
    exists: false,
    toplevel: null,
    originUrl: null,
    folderFiles: null,
    setupBlocked: null,
    currentBranch: null,
    branches: [],
    baseBranch: null,
    baseBranchExists: false,
    isGitRepo: false,
    t3Known: false,
    t3Error: null,
    t3ThreadCount: null,
    errors: [],
  };
  const abs = path.resolve(projectPath.trim().replace(/^"|"$/g, ''));
  if (!fs.existsSync(abs)) {
    v.errors.push(`Path does not exist: ${abs}`);
    return v;
  }
  if (!fs.statSync(abs).isDirectory()) {
    v.errors.push(`Not a folder: ${abs}`);
    return v;
  }
  v.exists = true;
  const top = await git.toplevel(abs);
  if (!top) {
    v.errors.push(`Not a git repository: ${abs}`);
    v.setupBlocked = protectedFolder(abs);
    if (!v.setupBlocked) v.folderFiles = countFiles(abs);
    return v;
  }
  v.isGitRepo = true;
  v.toplevel = path.resolve(top);
  v.originUrl = await git.remoteUrl(v.toplevel, 'origin');
  v.currentBranch = await git.currentBranch(v.toplevel);
  v.branches = await git.localBranches(v.toplevel);
  v.baseBranch = baseBranch?.trim() || v.currentBranch;
  if (!v.baseBranch) v.errors.push('The repository has no current branch (detached HEAD?); choose a base branch.');
  else {
    v.baseBranchExists = await git.refExists(v.toplevel, v.baseBranch);
    if (!v.baseBranchExists) v.errors.push(`Base branch "${v.baseBranch}" does not exist.`);
  }
  try {
    v.t3ThreadCount = historyThreads(await ctx.t3.list(v.toplevel)).length;
    v.t3Known = true;
  } catch (err) {
    v.t3Error = errorMessage(err);
    v.errors.push(ctx.health.healthy() ? 'T3 Code does not know this project yet. Use "Add to T3".' : "T3 Code isn't running.");
  }
  v.ok = v.isGitRepo && v.baseBranchExists && v.t3Known;
  return v;
}

export async function addProjectToT3(ctx: EngineContext, projectPath: string, baseBranch?: string | null): Promise<ProjectValidation> {
  const before = await validateProject(ctx, projectPath, baseBranch);
  if (!before.isGitRepo || !before.toplevel) return before;
  if (!before.t3Known) {
    try {
      await ctx.t3.addProject(before.toplevel);
    } catch (err) {
      return { ...before, t3Error: errorMessage(err), errors: [...before.errors, `t3 project add failed: ${errorMessage(err)}`] };
    }
  }
  return validateProject(ctx, before.toplevel, baseBranch);
}

function uniqueSlug(ctx: EngineContext, name: string): string {
  const base = slugify(name, 30) || 'board';
  let slug = base;
  for (let i = 2; ctx.db.select({ id: boards.id }).from(boards).where(eq(boards.slug, slug)).get(); i++) slug = `${base}-${i}`;
  return slug;
}

function uniqueShort(ctx: EngineContext): string {
  for (;;) {
    const s = randomBytes(2).toString('hex');
    if (!ctx.db.select({ id: boards.id }).from(boards).where(eq(boards.short, s)).get()) return s;
  }
}

export async function createBoard(ctx: EngineContext, body: CreateBoardBody): Promise<BoardRow> {
  const v = await validateProject(ctx, body.projectPath, body.baseBranch);
  if (!v.ok || !v.toplevel || !v.baseBranch) throw new AppError('VALIDATION', v.errors.join(' ') || 'Invalid project', 400, v);
  const defaults = { ...DEFAULT_BOARD_SETTINGS, ...ctx.settings.get().boardDefaults };
  const now = nowIso();
  const { name, projectPath: _p, baseBranch: _b, importFromT3: _i, ...settings } = body;
  void _p, _b, _i;
  const row: BoardRow = {
    id: newId(),
    name,
    slug: uniqueSlug(ctx, name),
    short: uniqueShort(ctx),
    projectPath: v.toplevel,
    t3ProjectId: null,
    baseBranch: v.baseBranch,
    brief: '',
    marketingBrief: '',
    securityBrief: '',
    securityReview: false,
    securityAutoScan: false,
    contextAutoBuild: true,
    contextInPrompts: true,
    ...defaults,
    ...stripUndefined(settings),
    nextTaskNumber: 1,
    nextPlanNumber: 1,
    nextMilestoneNumber: 1,
    observedRuntimeMode: null,
    runConfig: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  ctx.db.insert(boards).values(row).run();
  addEvent(ctx.db, { boardId: row.id, type: 'board_created', payload: { name, projectPath: row.projectPath, baseBranch: row.baseBranch } });
  emitBoard(ctx, row.id);
  return row;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function patchBoard(ctx: EngineContext, id: string, body: PatchBoardBody): Promise<BoardRow> {
  const board = getBoardOrThrow(ctx, id);
  const set = stripUndefined(body);
  if (set.baseBranch && set.baseBranch !== board.baseBranch && !(await git.refExists(board.projectPath, set.baseBranch))) {
    throw new AppError('VALIDATION', `Base branch "${set.baseBranch}" does not exist.`);
  }
  ctx.db.update(boards).set({ ...set, updatedAt: nowIso() }).where(eq(boards.id, id)).run();
  addEvent(ctx.db, { boardId: id, type: 'board_updated', payload: { fields: Object.keys(set) } });
  emitBoard(ctx, id);
  if ('autoRun' in set || 'maxParallel' in set || 'avoidOverlap' in set) ctx.kick();
  return getBoardOrThrow(ctx, id);
}

export function archiveBoard(ctx: EngineContext, id: string): void {
  getBoardOrThrow(ctx, id);
  ctx.db.update(boards).set({ archivedAt: nowIso(), autoRun: false, updatedAt: nowIso() }).where(eq(boards.id, id)).run();
  emitBoard(ctx, id);
}

export function listBoards(ctx: EngineContext) {
  return ctx.db
    .select()
    .from(boards)
    .where(isNull(boards.archivedAt))
    .all()
    .map((b) => boardView(ctx.db, b));
}

export function exportBoard(ctx: EngineContext, id: string) {
  const board = getBoardOrThrow(ctx, id);
  const taskRows = ctx.db.select().from(tasks).where(eq(tasks.boardId, id)).all();
  const ids = new Set(taskRows.map((t) => t.id));
  const planRows = ctx.db.select().from(plans).where(eq(plans.boardId, id)).all();
  const planIds = new Set(planRows.map((p) => p.id));
  return {
    exportedAt: nowIso(),
    board,
    tasks: taskRows,
    taskDeps: ctx.db.select().from(taskDeps).all().filter((d) => ids.has(d.taskId)),
    plans: planRows,
    milestones: ctx.db.select().from(milestones).where(eq(milestones.boardId, id)).all(),
    planVersions: ctx.db.select().from(planVersions).all().filter((v) => planIds.has(v.planId)),
    planSpecRounds: ctx.db.select().from(planSpecRounds).all().filter((r) => planIds.has(r.planId)),
    runs: ctx.db.select().from(runs).where(eq(runs.boardId, id)).all(),
    reviewFindings: ctx.db.select().from(reviewFindings).all().filter((f) => ids.has(f.taskId)),
    events: ctx.db.select().from(events).where(eq(events.boardId, id)).all(),
  };
}
