// "Run project" for the HTTP API: which directory, which recipe, and the board's saved command.
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectRunView, RunConfig, RunInfoView, RunRecipe, StartRunBody } from '@t3-orchestra/shared';
import { eq } from 'drizzle-orm';
import { boards } from '../db/schema.ts';
import { AppError, emitBoard, getBoardOrThrow, getTaskOrThrow, type EngineContext } from '../engine/context.ts';
import { remoteUrl } from '../git/git.ts';
import { parseGithubRepo } from '../marketing/sources.ts';
import { nowIso } from '../util.ts';
import { composeDown } from './detect.ts';
import type { ProjectRunManager } from './manager.ts';
import { openInVsCode } from './system.ts';

export function customRecipe(c: RunConfig): RunRecipe {
  const stop = composeDown(c.command);
  return {
    ...(stop ? { stop } : {}),
    id: 'custom',
    label: 'Your command',
    kind: c.mode === 'terminal' ? 'console' : 'web',
    mode: c.mode,
    cwd: c.cwd,
    steps: [{ label: 'Run', command: c.command }],
    reason: "Saved in this board's settings",
    url: null,
    source: 'custom',
    warning: null,
  };
}

/** The board's root checkout, or the task's worktree. */
function targetDir(ctx: EngineContext, boardId: string, taskId: string | null): string {
  const board = getBoardOrThrow(ctx, boardId);
  if (!taskId) {
    if (!fs.existsSync(board.projectPath)) throw new AppError('NOT_FOUND', `The project folder ${board.projectPath} is missing.`, 404);
    return board.projectPath;
  }
  const task = getTaskOrThrow(ctx, taskId);
  if (!task.worktreePath) throw new AppError('VALIDATION', `Task #${task.number} has no worktree yet; start it first.`);
  if (!fs.existsSync(task.worktreePath)) throw new AppError('NOT_FOUND', `The worktree ${task.worktreePath} is gone.`, 404);
  return task.worktreePath;
}

function checkCwd(dir: string, cwd: string): void {
  const full = path.resolve(dir, cwd || '.');
  const rel = path.relative(dir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new AppError('VALIDATION', 'The folder must be inside the project.');
  if (!fs.existsSync(full)) throw new AppError('VALIDATION', `There is no folder "${cwd}" in the project.`);
}

async function recipesFor(ctx: EngineContext, runs: ProjectRunManager, boardId: string, dir: string): Promise<RunRecipe[]> {
  const saved = getBoardOrThrow(ctx, boardId).runConfig;
  const detected = await runs.detect(dir);
  return saved ? [customRecipe(saved), ...detected] : detected;
}

export async function runInfo(ctx: EngineContext, runs: ProjectRunManager, boardId: string, taskId: string | null): Promise<RunInfoView> {
  const dir = targetDir(ctx, boardId, taskId);
  return {
    dir,
    recipes: await recipesFor(ctx, runs, boardId, dir),
    config: getBoardOrThrow(ctx, boardId).runConfig ?? null,
    run: runs.current(boardId, taskId),
  };
}

/** Opens the board's root checkout, or the task's worktree, in VS Code. */
export async function openProjectInVsCode(ctx: EngineContext, boardId: string, taskId: string | null): Promise<{ dir: string }> {
  const dir = targetDir(ctx, boardId, taskId);
  if (!(await openInVsCode(dir))) {
    throw new AppError('NOT_FOUND', "Couldn't find VS Code on this computer. Install it, or put its `code` command on PATH.", 404);
  }
  return { dir };
}

/** The GitHub page of the board's repository (its `origin` remote), or null when origin isn't on github.com. */
export async function projectGithubUrl(ctx: EngineContext, boardId: string): Promise<{ url: string | null }> {
  const remote = await remoteUrl(getBoardOrThrow(ctx, boardId).projectPath, 'origin');
  // https://user:token@github.com/… → drop the credentials before matching
  const repo = remote && /github\.com/i.test(remote) ? parseGithubRepo(remote.replace(/^(https?:\/\/)[^@/]+@/i, '$1')) : null;
  return { url: repo ? `https://github.com/${repo}` : null };
}

export async function startProjectRun(
  ctx: EngineContext,
  runs: ProjectRunManager,
  boardId: string,
  taskId: string | null,
  body: StartRunBody,
): Promise<ProjectRunView> {
  const dir = targetDir(ctx, boardId, taskId);
  let recipe: RunRecipe | undefined;
  if (body.config) {
    checkCwd(dir, body.config.cwd);
    recipe = customRecipe(body.config);
    if (body.save) {
      ctx.db.update(boards).set({ runConfig: body.config, updatedAt: nowIso() }).where(eq(boards.id, boardId)).run();
      emitBoard(ctx, boardId);
    }
  } else {
    const recipes = await recipesFor(ctx, runs, boardId, dir);
    recipe = body.recipeId ? recipes.find((r) => r.id === body.recipeId) : recipes[0];
    if (!recipe) {
      throw new AppError(
        'NOTHING_TO_RUN',
        body.recipeId ? 'That way of running the project is no longer offered; pick another.' : "Couldn't tell how to run this project. Enter the command to use.",
        422,
      );
    }
  }
  return runs.start({ boardId, taskId, dir }, recipe);
}
