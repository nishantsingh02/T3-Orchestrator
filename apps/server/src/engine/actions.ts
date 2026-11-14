// User actions on tasks: POST /api/tasks/:id/actions/:action (spec §5.4–§5.8, §11.3, §13).
import type { DesignChoice, TaskAction, TaskActionBody, TaskEvent } from '@t3-orchestra/shared';
import { and, eq } from 'drizzle-orm';
import { boards, designRounds, reviewFindings, type BoardRow, type TaskRow } from '../db/schema.ts';
import { buildTaskViews } from '../db/views.ts';
import * as git from '../git/git.ts';
import { isContextPath } from '../knowledge/files.ts';
import { errorMessage, nowIso } from '../util.ts';
import { addEvent, AppError, emitTask, getTaskOrThrow, viewCtx, type EngineContext } from './context.ts';
import { awaitingDesign, describeChoice, designDir, designFilePath, designRoundsOf } from './designs.ts';
import { refreshDiffStat } from './reconciler.ts';
import { nextDesignDir, rerunReview, sendTaskMessage, startTaskThread } from './runs.ts';
import { transition } from './transitions.ts';

function apply(ctx: EngineContext, task: TaskRow, event: TaskEvent, o: Parameters<typeof transition>[3] = {}): TaskRow {
  const r = transition(ctx, task.id, event, { actor: 'user', ...o });
  if (!r.ok) throw new AppError('ILLEGAL_TRANSITION', `${event.type} is not allowed for #${task.number} in ${task.stage}`, 409);
  return r.task;
}

/** Who approves: the user, or the engine because the AI review score was under the board's limit. */
type Approver = { auto: false } | { auto: true; score: number; below: number };

const USER: Approver = { auto: false };

function approveEvent(by: Approver, outcome: 'merged' | 'conflict' | 'manual'): TaskEvent {
  return by.auto ? { type: 'auto.approve', outcome } : { type: 'user.approve', outcome };
}

function approverOptions(by: Approver, payload: Record<string, unknown>) {
  return by.auto
    ? { actor: 'reconciler' as const, payload: { ...payload, score: by.score, below: by.below } }
    : { actor: 'user' as const, payload };
}

/** Nothing is built while the agent waits for a design pick, so there is nothing to approve or review. */
function requireNoDesignPending(task: TaskRow, what: string) {
  if (awaitingDesign(task)) {
    throw new AppError('ILLEGAL_TRANSITION', `#${task.number} is waiting for you to pick a design; nothing is built yet to ${what}.`, 409);
  }
}

function approve(ctx: EngineContext, task: TaskRow, board: BoardRow, by: Approver): Promise<TaskRow> | TaskRow {
  if (task.stage !== 'human_review') throw new AppError('ILLEGAL_TRANSITION', 'only tasks in Human Review can be approved', 409);
  requireNoDesignPending(task, 'approve');
  if (board.mergeStrategy === 'manual') return apply(ctx, task, approveEvent(by, 'manual'), approverOptions(by, { strategy: 'manual' }));
  if (board.mergeStrategy === 'pr') return openPr(ctx, task, board.baseBranch, by);
  return localMerge(ctx, task, board.projectPath, board.baseBranch, by);
}

/**
 * Approves an AI-passed task without the user (its review score is under the board's limit), the
 * same way the Approve button would. Throws the same errors, e.g. MERGE_CONFLICT or DIRTY_ROOT.
 */
export async function autoApprove(ctx: EngineContext, taskId: string, score: number, below: number): Promise<TaskRow> {
  const task = getTaskOrThrow(ctx, taskId);
  const board = ctx.db.select().from(boards).where(eq(boards.id, task.boardId)).get()!;
  return approve(ctx, task, board, { auto: true, score, below });
}

function requireText(body: TaskActionBody, what: string): string {
  const t = body.text?.trim();
  if (!t) throw new AppError('VALIDATION', `${what} needs some text`);
  return t;
}

export async function runAction(ctx: EngineContext, taskId: string, action: TaskAction, body: TaskActionBody): Promise<TaskRow> {
  const task = getTaskOrThrow(ctx, taskId);
  const board = ctx.db.select().from(boards).where(eq(boards.id, task.boardId)).get()!;
  const view = () => buildTaskViews(ctx.db, [task], viewCtx(ctx))[0]!;

  switch (action) {
    case 'start': {
      if (task.stage !== 'backlog' && task.stage !== 'ready') throw new AppError('ILLEGAL_TRANSITION', `#${task.number} is ${task.stage}`, 409);
      const waitingOn = view().waitingOn;
      if (waitingOn.length && !body.force) {
        const list = waitingOn.map((d) => `#${d.number} (${d.stage.replace('_', ' ')})`).join(', ');
        throw new AppError('DEPS_NOT_DONE', `#${task.number} depends on ${list}. Start anyway?`, 409, { waitingOn });
      }
      return startTaskThread(ctx, taskId, 'user.start', 'user');
    }

    case 'move-to-ready':
      return apply(ctx, task, { type: 'user.move_to_ready' });

    case 'move-to-backlog':
      // Failed → Backlog resets the thread link; the old thread stays in the run history and the
      // next start uses a fresh branch suffix.
      return apply(ctx, task, { type: 'user.move_to_backlog' }, {
        patch:
          task.stage === 'failed'
            ? { threadId: null, threadLink: null, worktreePath: null, branch: null, attempt: task.attempt + 1, fixRound: 0, reviewRound: 0, lastT3RunId: null, activitySinceReview: false }
            : {},
      });

    case 'resume': {
      if (task.stage !== 'failed') throw new AppError('ILLEGAL_TRANSITION', 'only failed tasks can be resumed', 409);
      const message = ctx.prompts.render('resume', { num: task.number, status: task.lastThreadStatus ?? task.stageReason ?? 'unknown', note: body.note?.trim() || body.text?.trim() || '' });
      return sendTaskMessage(ctx, taskId, { kind: 'resume', message, event: { type: 'user.resume' }, actor: 'user' });
    }

    case 'retry-fresh':
      if (task.stage !== 'failed') throw new AppError('ILLEGAL_TRANSITION', 'only failed tasks can be retried', 409);
      return startTaskThread(ctx, taskId, 'user.retry_fresh', 'user');

    case 'request-changes': {
      const feedback = requireText(body, 'Request changes');
      const message = ctx.prompts.render('changes', { num: task.number, feedback, branch: task.branch ?? '', designDir: nextDesignDir(ctx, taskId) });
      return sendTaskMessage(ctx, taskId, { kind: 'changes', message, event: { type: 'user.request_changes' }, actor: 'user', patch: { fixRound: 0 } });
    }

    case 'send-message': {
      const text = requireText(body, 'Send message');
      const message = ctx.prompts.render('followup', { num: task.number, message: text, branch: task.branch ?? '', designDir: nextDesignDir(ctx, taskId) });
      return sendTaskMessage(ctx, taskId, { kind: 'followup', message, event: { type: 'user.send_message' }, actor: 'user' });
    }

    case 'choose-design':
      return chooseDesign(ctx, task, body.design);

    case 'rerun-review':
      requireNoDesignPending(task, 'review');
      return rerunReview(ctx, taskId);

    case 'approve':
      return approve(ctx, task, board, USER);

    case 'update-branch': {
      const message = ctx.prompts.render('rebase', { baseBranch: board.baseBranch, branch: task.branch ?? '' });
      return sendTaskMessage(ctx, taskId, { kind: 'rebase', message, event: { type: 'user.update_branch' }, actor: 'user' });
    }

    case 'open-pr':
      requireNoDesignPending(task, 'open a PR for');
      return openPr(ctx, task, board.baseBranch, USER);

    case 'mark-done':
      return apply(ctx, task, { type: 'user.mark_done' });

    case 'discard':
      return apply(ctx, task, { type: 'user.discard' });

    case 'dismiss-finding': {
      if (!body.findingId) throw new AppError('VALIDATION', 'findingId is required');
      const res = ctx.db
        .update(reviewFindings)
        .set({ status: 'dismissed' })
        .where(and(eq(reviewFindings.id, body.findingId), eq(reviewFindings.taskId, taskId)))
        .run();
      if (res.changes === 0) throw new AppError('NOT_FOUND', 'finding not found', 404);
      addEvent(ctx.db, { boardId: task.boardId, taskId, type: 'finding_dismissed', payload: { findingId: body.findingId } });
      emitTask(ctx, taskId);
      return getTaskOrThrow(ctx, taskId);
    }
  }
}

/**
 * The user's answer to the open round of design options: build the picks (any round's, combined as
 * their notes say), or make another round in that direction. Either way the task goes back to its thread.
 */
async function chooseDesign(ctx: EngineContext, task: TaskRow, choice: DesignChoice | undefined): Promise<TaskRow> {
  if (!choice) throw new AppError('VALIDATION', 'choose-design needs a design choice');
  if (!awaitingDesign(task)) throw new AppError('ILLEGAL_TRANSITION', `#${task.number} isn't waiting for a design choice`, 409);
  const rounds = designRoundsOf(ctx.db, task.id);
  const open = rounds.at(-1);
  if (open?.status !== 'open') throw new AppError('ILLEGAL_TRANSITION', `#${task.number} has no open round of design options`, 409);

  const seen = new Set<string>();
  const picks = choice.picks.filter((p) => {
    const key = `${p.round}/${p.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const p of picks) {
    const known = rounds.find((r) => r.round === p.round)?.options.some((o) => o.file === p.file);
    if (!known || !designFilePath(ctx.config.dataDir, task.id, p.round, p.file)) {
      throw new AppError('VALIDATION', `Round ${p.round} has no design option ${p.file}`);
    }
  }
  const decided: DesignChoice = { ...choice, picks };
  const build = choice.mode === 'build';
  const nextRound = open.round + 1;
  const message = ctx.prompts.render('design', {
    num: task.number,
    branch: task.branch ?? '',
    build,
    more: !build,
    several: picks.length > 1,
    choice: describeChoice(rounds, ctx.config.dataDir, task.id, decided),
    designDir: designDir(ctx.config.dataDir, task.id, nextRound),
    nextRound,
  });
  return sendTaskMessage(ctx, task.id, {
    kind: build ? 'design' : 'options',
    message,
    event: { type: 'user.choose_design' },
    actor: 'user',
    round: build ? open.round : nextRound,
    payload: { mode: choice.mode, round: open.round, picks: picks.length },
    also: (tx) => {
      tx.update(designRounds)
        .set({ status: build ? 'chosen' : 'more', choice: decided, decidedAt: nowIso() })
        .where(eq(designRounds.id, open.id))
        .run();
    },
  });
}

function openPr(ctx: EngineContext, task: TaskRow, baseBranch: string, by: Approver): Promise<TaskRow> {
  const message = ctx.prompts.render('pr', { branch: task.branch ?? '', baseBranch, num: task.number, title: task.title });
  return sendTaskMessage(ctx, task.id, { kind: 'pr', message, event: { type: 'user.open_pr' }, ...approverOptions(by, {}) });
}

/** Local merge strategy (spec §13). */
async function localMerge(ctx: EngineContext, task: TaskRow, root: string, baseBranch: string, by: Approver): Promise<TaskRow> {
  if (!task.branch) throw new AppError('GIT_ERROR', `#${task.number} has no branch to merge`, 409);
  try {
    if (task.worktreePath) {
      const dirty = await git.uncommitted(task.worktreePath);
      if (dirty.length) {
        throw new AppError(
          'DIRTY_WORKTREE',
          `The task worktree has ${dirty.length} uncommitted change(s) (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}). Ask the agent to commit them ("Send message"), or commit them yourself in ${task.worktreePath}.`,
          409,
          { files: dirty },
        );
      }
    }
    const current = await git.currentBranch(root);
    if (current !== baseBranch) {
      throw new AppError(
        'DIRTY_ROOT',
        `The root checkout (${root}) is on ${current ? `branch "${current}"` : 'a detached HEAD'}, not "${baseBranch}". Check out "${baseBranch}" there and try again. T3 Orchestra never switches branches or stashes for you.`,
        409,
      );
    }
    // Context files the board writes don't block a merge; git still refuses one that would overwrite them.
    const dirtyRoot = (await git.trackedChanges(root)).filter((p) => !isContextPath(p));
    if (dirtyRoot.length > 0) {
      throw new AppError(
        'DIRTY_ROOT',
        `The root checkout (${root}) has ${dirtyRoot.length} uncommitted change(s) to tracked files (${dirtyRoot.slice(0, 5).join(', ')}). Commit or stash them yourself, then approve again.`,
        409,
        { files: dirtyRoot },
      );
    }
    const ahead = await git.aheadBy(root, baseBranch, task.branch);
    if (ahead < 0) throw new AppError('GIT_ERROR', `Branch ${task.branch} was not found in ${root}.`, 409);
    if (ahead === 0) {
      throw new AppError(
        'NOTHING_TO_MERGE',
        `${task.branch} has no commits that ${baseBranch} doesn't already have. Ask the agent to commit its work, or use "Mark done" if there is nothing to merge.`,
        409,
      );
    }
    const outcome = await git.mergeNoFf(root, task.branch, `#${task.number} ${task.title} (T3 Orchestra)`);
    if (outcome.ok) {
      return apply(ctx, task, approveEvent(by, 'merged'), approverOptions(by, { strategy: 'local', mergeSha: outcome.sha, branch: task.branch }));
    }
    if (outcome.conflict) {
      apply(ctx, task, approveEvent(by, 'conflict'), approverOptions(by, { strategy: 'local', files: outcome.files }));
      await refreshDiffStat(ctx, task.id);
      throw new AppError(
        'MERGE_CONFLICT',
        `Merging ${task.branch} into ${baseBranch} conflicts (${outcome.files.join(', ') || 'unknown files'}). The merge was aborted; use "Update branch" to have the agent merge ${baseBranch} into its branch.`,
        409,
        { files: outcome.files },
      );
    }
    throw new AppError('GIT_ERROR', `git merge failed: ${outcome.error}`, 500);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('GIT_ERROR', errorMessage(err), 500);
  }
}
