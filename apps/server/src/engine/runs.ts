// Starting threads and sending messages, crash-safely (spec §11.1 runs.ts, §15.3).
//
// Pattern for every agent turn:
//   1. render the prompt (reads only),
//   2. in ONE transaction: insert the run row (status `starting`) + transition the task,
//   3. call T3 (start or send),
//   4. link the thread / mark the run active, or recover (marker lookup / latestRunId check).
// A crash between 2 and 4 leaves a `starting` run that recoverStartingRun() resolves on boot.
import { ImplementResult, runOrdinal, type RunKind, type TaskEvent, type ThreadRole } from '@t3-orchestra/shared';
import { and, asc, eq, ne } from 'drizzle-orm';
import {
  boards,
  contextBuilds,
  ideaBatches,
  insightChats,
  insightMessages,
  plans,
  projectImports,
  reviewFindings,
  runs,
  securityAudits,
  taskDeps,
  tasks,
  type BoardRow,
  type RunLaunch,
  type RunRow,
  type TaskRow,
} from '../db/schema.ts';
import { latestSpecRound, specRoundRows, specText } from '../db/views.ts';
import { childLog } from '../log.ts';
import { isNotFound, T3CliError, type ThreadDetail } from '../t3/T3Client.ts';
import { errorMessage, newId, nowIso, reviewMarker, taskBranchName, taskMarker } from '../util.ts';
import { emitSecurityAudit } from '../security/service.ts';
import { emitKnowledgeBuild, emitKnowledgeChanged, knowledgeFor } from '../knowledge/service.ts';
import { addEvent, AppError, emitBoard, emitIdeaBatch, emitInsightChat, emitInsightMessage, emitPlan, emitTask, type DbOrTx, type EngineContext } from './context.ts';
import { chosenDesign, designDir, nextDesignRound } from './designs.ts';
import { screenshotDir } from './screenshots.ts';
import { transition, type TaskPatch } from './transitions.ts';

const log = childLog('runs');

/** Runs currently being launched by this process (the reconciler leaves them alone). */
export const launching = new Set<string>();

export interface NewRun {
  boardId: string;
  taskId?: string | null;
  planId?: string | null;
  kind: RunKind;
  threadRole: ThreadRole;
  round?: number | null;
  promptText: string;
  /** New thread. */
  launch?: RunLaunch;
  marker?: string;
  /** Send to an existing thread. */
  threadId?: string;
  threadLink?: string | null;
  baselineRunId?: string | null;
  startItemCount?: number | null;
  /** A run T3 Orchestra did not start, adopted already running (Insights: the agent continuing on its own). */
  adopted?: { t3RunId: string | null };
}

export function insertRun(tx: DbOrTx, r: NewRun): RunRow {
  const row: RunRow = {
    id: newId(),
    boardId: r.boardId,
    taskId: r.taskId ?? null,
    planId: r.planId ?? null,
    kind: r.kind,
    threadId: r.threadId ?? null,
    threadLink: r.threadLink ?? null,
    threadRole: r.threadRole,
    marker: r.marker ?? null,
    launch: r.launch ?? null,
    round: r.round ?? null,
    baselineRunId: r.baselineRunId ?? null,
    t3RunId: r.adopted?.t3RunId ?? null,
    external: r.adopted !== undefined,
    status: r.adopted ? 'active' : 'starting',
    startItemCount: r.startItemCount ?? null,
    promptText: r.promptText,
    resultRaw: null,
    resultJson: null,
    error: null,
    startedAt: nowIso(),
    finishedAt: null,
  };
  tx.insert(runs).values(row).run();
  addEvent(tx, { boardId: r.boardId, taskId: r.taskId, planId: r.planId, runId: row.id, type: 'run_created', payload: { kind: r.kind, round: r.round ?? null, role: r.threadRole } });
  return row;
}

function getRun(ctx: EngineContext, id: string): RunRow {
  const r = ctx.db.select().from(runs).where(eq(runs.id, id)).get();
  if (!r) throw new Error(`run ${id} vanished`);
  return r;
}

// ---------------------------------------------------------------------------
// Launch (step 3–4)
// ---------------------------------------------------------------------------

export async function launchRun(ctx: EngineContext, runId: string): Promise<void> {
  launching.add(runId);
  try {
    const run = getRun(ctx, runId);
    if (run.status !== 'starting') return;
    if (run.launch && !run.threadId) {
      try {
        const res = await ctx.t3.startThread({ ...run.launch, message: run.promptText });
        await linkThread(ctx, run, res.threadId, res.runId ?? null, res.link ?? null);
      } catch (err) {
        log.warn({ runId, err: errorMessage(err) }, 'thread start failed; looking for the marker');
        if (err instanceof T3CliError && err.unavailable) void ctx.health.check();
        await recoverStart(ctx, run, err);
      }
    } else if (run.threadId) {
      try {
        const res = await ctx.t3.send(run.threadId, run.promptText);
        markActive(ctx, run, res.runId ?? null);
      } catch (err) {
        log.warn({ runId, err: errorMessage(err) }, 'send failed; checking latestRunId');
        if (err instanceof T3CliError && err.unavailable) void ctx.health.check();
        await recoverSend(ctx, run, err);
      }
    } else {
      failRunStart(ctx, run, 'run has neither a launch spec nor a thread');
    }
  } catch (err) {
    log.error({ runId, err }, 'launchRun crashed');
  } finally {
    launching.delete(runId);
  }
}

/** Resolves a `starting` run left by a crash or an outage (boot + every reconcile tick). */
export async function recoverStartingRun(ctx: EngineContext, run: RunRow): Promise<void> {
  if (launching.has(run.id)) return;
  launching.add(run.id);
  try {
    if (run.launch && !run.threadId) await recoverStart(ctx, run, null);
    else if (run.threadId) await recoverSend(ctx, run, null);
    else failRunStart(ctx, run, 'run has neither a launch spec nor a thread');
  } finally {
    launching.delete(run.id);
  }
}

async function recoverStart(ctx: EngineContext, run: RunRow, err: unknown): Promise<void> {
  const launch = run.launch!;
  let list;
  try {
    list = await ctx.t3.list(launch.project);
  } catch (listErr) {
    // T3 unreachable: keep the run `starting`; the reconciler retries the lookup when T3 is back.
    if (listErr instanceof T3CliError && listErr.unavailable) {
      ctx.db.update(runs).set({ error: `start pending: ${errorMessage(err ?? listErr)}` }).where(eq(runs.id, run.id)).run();
      void ctx.health.check();
      return;
    }
    failRunStart(ctx, run, `start failed (${errorMessage(err)}); marker lookup failed: ${errorMessage(listErr)}`);
    return;
  }
  const since = Date.parse(run.startedAt) - 60_000;
  const linked = new Set(
    ctx.db
      .select({ threadId: runs.threadId })
      .from(runs)
      .where(and(ne(runs.id, run.id), eq(runs.threadRole, run.threadRole)))
      .all()
      .map((r) => r.threadId)
      .filter(Boolean),
  );
  const found = list
    .filter((t) => run.marker && t.title.includes(run.marker) && Date.parse(t.createdAt) >= since && !linked.has(t.threadId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (found) {
    log.info({ runId: run.id, threadId: found.threadId }, 'found thread by marker');
    addEvent(ctx.db, { boardId: run.boardId, taskId: run.taskId, planId: run.planId, runId: run.id, type: 'thread_recovered', payload: { threadId: found.threadId, marker: run.marker } });
    await linkThread(ctx, run, found.threadId, null, found.link);
    return;
  }
  failRunStart(ctx, run, err ? `start failed: ${errorMessage(err)}` : 'thread was never started (no thread with the title marker found)');
}

async function recoverSend(ctx: EngineContext, run: RunRow, err: unknown): Promise<void> {
  try {
    const { thread } = await ctx.t3.show(run.threadId!, { messages: 1 });
    if (thread.latestRunId && thread.latestRunId !== run.baselineRunId) {
      log.info({ runId: run.id }, 'send went through after all (latestRunId moved)');
      markActive(ctx, run, thread.latestRunId);
      return;
    }
    if (err === null && ['queued', 'starting', 'preparing', 'running', 'waiting'].includes(thread.status)) {
      // Busy thread: a queued message only moves latestRunId once it starts. Wait.
      markActive(ctx, run, null);
      return;
    }
    failRunStart(ctx, run, err ? `send failed: ${errorMessage(err)}` : 'message was not delivered');
  } catch (showErr) {
    if (isNotFound(showErr)) {
      threadMissing(ctx, run);
      return;
    }
    if (showErr instanceof T3CliError && showErr.unavailable) {
      ctx.db.update(runs).set({ error: `send pending: ${errorMessage(err ?? showErr)}` }).where(eq(runs.id, run.id)).run();
      return;
    }
    failRunStart(ctx, run, `send failed: ${errorMessage(err ?? showErr)}`);
  }
}

async function linkThread(ctx: EngineContext, run: RunRow, threadId: string, t3RunId: string | null, link: string | null) {
  ctx.db.update(runs).set({ threadId, t3RunId, threadLink: link, status: 'active', error: null }).where(eq(runs.id, run.id)).run();
  let detail: ThreadDetail | null = null;
  try {
    detail = (await ctx.t3.show(threadId, { messages: 1 })).thread;
  } catch (err) {
    log.warn({ runId: run.id, err: errorMessage(err) }, 'show after start failed');
  }
  const threadLink = detail?.link ?? link;
  ctx.db
    .update(runs)
    .set({ threadLink, startItemCount: detail?.itemCount ?? null, t3RunId: t3RunId ?? detail?.latestRunId ?? null })
    .where(eq(runs.id, run.id))
    .run();
  if (detail) recordBoardFacts(ctx, run.boardId, detail);

  if (run.threadRole === 'task' && run.taskId) {
    ctx.db
      .update(tasks)
      .set({
        threadId,
        threadLink,
        worktreePath: detail?.worktreePath ?? null,
        branch: detail?.branch ?? run.launch?.worktree?.branch ?? null,
        lastItemCount: detail?.itemCount ?? null,
        lastThreadStatus: detail?.status ?? null,
        lastActivityAt: detail?.updatedAt ?? nowIso(),
        lastT3RunId: detail?.latestRunId ?? t3RunId,
        updatedAt: nowIso(),
      })
      .where(eq(tasks.id, run.taskId))
      .run();
  } else if (run.threadRole === 'review' && run.taskId) {
    ctx.db.update(tasks).set({ lastActivityAt: detail?.updatedAt ?? nowIso(), updatedAt: nowIso() }).where(eq(tasks.id, run.taskId)).run();
  } else if (run.threadRole === 'plan' && run.planId) {
    ctx.db.update(plans).set({ threadId, threadLink, updatedAt: nowIso() }).where(eq(plans.id, run.planId)).run();
    emitPlan(ctx, run.planId);
  } else if (run.threadRole === 'insight') {
    const answer = insightAnswer(ctx, run.id);
    if (answer) {
      ctx.db.update(insightChats).set({ threadId, threadLink }).where(eq(insightChats.id, answer.chatId)).run();
      emitInsightChat(ctx, answer.chatId);
    }
  } else if (run.threadRole === 'ideas') {
    const batch = ideaBatchOfRun(ctx, run.id);
    if (batch) {
      ctx.db.update(ideaBatches).set({ threadId, threadLink, updatedAt: nowIso() }).where(eq(ideaBatches.id, batch.id)).run();
      emitIdeaBatch(ctx, batch.id);
    }
  } else if (run.threadRole === 'import') {
    const imp = importOfRun(ctx, run.id);
    if (imp) {
      ctx.db.update(projectImports).set({ threadId, threadLink, updatedAt: nowIso() }).where(eq(projectImports.id, imp.id)).run();
      emitBoard(ctx, imp.boardId);
    }
  } else if (run.threadRole === 'security') {
    const audit = auditOfRun(ctx, run.id);
    if (audit) {
      ctx.db.update(securityAudits).set({ threadId, threadLink, updatedAt: nowIso() }).where(eq(securityAudits.id, audit.id)).run();
      emitSecurityAudit(ctx, audit.id);
    }
  } else if (run.threadRole === 'knowledge') {
    const build = buildOfRun(ctx, run.id);
    if (build) {
      ctx.db.update(contextBuilds).set({ threadId, threadLink, updatedAt: nowIso() }).where(eq(contextBuilds.id, build.id)).run();
      emitKnowledgeBuild(ctx, build.id);
    }
  }
  addEvent(ctx.db, { boardId: run.boardId, taskId: run.taskId, planId: run.planId, runId: run.id, type: 'thread_started', payload: { threadId, link: threadLink, kind: run.kind } });
  if (run.taskId) emitTask(ctx, run.taskId);
}

function markActive(ctx: EngineContext, run: RunRow, t3RunId: string | null) {
  ctx.db.update(runs).set({ status: 'active', t3RunId, error: null }).where(eq(runs.id, run.id)).run();
  if (run.taskId) {
    ctx.db.update(tasks).set({ lastActivityAt: nowIso(), updatedAt: nowIso() }).where(eq(tasks.id, run.taskId)).run();
    emitTask(ctx, run.taskId);
  }
  if (run.planId) emitPlan(ctx, run.planId);
}

/** Board-level facts learned from any thread: T3 project id and runtime mode (spec §16). */
export function recordBoardFacts(ctx: EngineContext, boardId: string, t: Pick<ThreadDetail, 'projectId' | 'runtimeMode'>) {
  const b = ctx.db.select({ p: boards.t3ProjectId, m: boards.observedRuntimeMode }).from(boards).where(eq(boards.id, boardId)).get();
  if (!b) return;
  const set: Partial<BoardRow> = {};
  if (t.projectId && b.p !== t.projectId) set.t3ProjectId = t.projectId;
  if (t.runtimeMode && b.m !== t.runtimeMode) set.observedRuntimeMode = t.runtimeMode;
  if (Object.keys(set).length) ctx.db.update(boards).set(set).where(eq(boards.id, boardId)).run();
}

export function finishRun(tx: DbOrTx, runId: string, set: Partial<RunRow>): void {
  tx.update(runs)
    .set({ finishedAt: nowIso(), ...set })
    .where(eq(runs.id, runId))
    .run();
}

function insightAnswer(ctx: EngineContext, runId: string) {
  return ctx.db.select().from(insightMessages).where(eq(insightMessages.runId, runId)).get();
}

/** Marks a chat answer failed with its run; a lost thread also unlinks the chat, so the next question starts a new one. */
function failInsightAnswer(ctx: EngineContext, run: RunRow, finish: (tx: DbOrTx) => void, error: string, threadLost: boolean) {
  const answer = insightAnswer(ctx, run.id);
  ctx.db.transaction((tx) => {
    finish(tx);
    if (!answer) return;
    tx.update(insightMessages).set({ status: 'failed', error, finishedAt: nowIso() }).where(eq(insightMessages.id, answer.id)).run();
    if (threadLost) tx.update(insightChats).set({ threadId: null, threadLink: null }).where(eq(insightChats.id, answer.chatId)).run();
  });
  if (answer) emitInsightMessage(ctx, answer.id);
}

export function ideaBatchOfRun(ctx: EngineContext, runId: string) {
  return ctx.db.select().from(ideaBatches).where(eq(ideaBatches.runId, runId)).get();
}

/** Marks an idea generation failed with its run. */
export function failIdeaBatch(ctx: EngineContext, run: RunRow, finish: (tx: DbOrTx) => void, error: string) {
  const batch = ideaBatchOfRun(ctx, run.id);
  ctx.db.transaction((tx) => {
    finish(tx);
    if (!batch) return;
    const now = nowIso();
    tx.update(ideaBatches).set({ status: 'failed', error, finishedAt: now, updatedAt: now }).where(eq(ideaBatches.id, batch.id)).run();
  });
  if (batch) emitIdeaBatch(ctx, batch.id);
}

export function importOfRun(ctx: EngineContext, runId: string) {
  return ctx.db.select().from(projectImports).where(eq(projectImports.runId, runId)).get();
}

/** Marks an import failed with its run. */
export function failImportRun(ctx: EngineContext, run: RunRow, finish: (tx: DbOrTx) => void, error: string) {
  const imp = importOfRun(ctx, run.id);
  ctx.db.transaction((tx) => {
    finish(tx);
    if (!imp) return;
    const now = nowIso();
    tx.update(projectImports).set({ status: 'failed', error, finishedAt: now, updatedAt: now }).where(eq(projectImports.id, imp.id)).run();
  });
  if (imp) emitBoard(ctx, imp.boardId);
}

export function auditOfRun(ctx: EngineContext, runId: string) {
  return ctx.db.select().from(securityAudits).where(eq(securityAudits.runId, runId)).get();
}

/** Marks a security audit failed with its run. */
export function failAuditRun(ctx: EngineContext, run: RunRow, finish: (tx: DbOrTx) => void, error: string) {
  const audit = auditOfRun(ctx, run.id);
  ctx.db.transaction((tx) => {
    finish(tx);
    if (!audit) return;
    const now = nowIso();
    tx.update(securityAudits).set({ status: 'failed', error, finishedAt: now, updatedAt: now }).where(eq(securityAudits.id, audit.id)).run();
  });
  if (audit) emitSecurityAudit(ctx, audit.id);
}

export function buildOfRun(ctx: EngineContext, runId: string) {
  return ctx.db.select().from(contextBuilds).where(eq(contextBuilds.runId, runId)).get();
}

/** Marks a knowledge graph build failed with its run; its files stay pending. */
export function failKnowledgeRun(ctx: EngineContext, run: RunRow, finish: (tx: DbOrTx) => void, error: string) {
  const build = buildOfRun(ctx, run.id);
  ctx.db.transaction((tx) => {
    finish(tx);
    if (!build) return;
    const now = nowIso();
    tx.update(contextBuilds).set({ status: 'failed', error, finishedAt: now, updatedAt: now }).where(eq(contextBuilds.id, build.id)).run();
  });
  if (!build) return;
  emitKnowledgeBuild(ctx, build.id);
  emitKnowledgeChanged(ctx, build.boardId);
}

function failRunStart(ctx: EngineContext, run: RunRow, message: string) {
  log.warn({ runId: run.id, message }, 'run could not be started');
  const finish = (tx: DbOrTx) => finishRun(tx, run.id, { status: 'failed', error: message });
  if (run.threadRole === 'insight') return failInsightAnswer(ctx, run, finish, `The agent could not be started: ${message}`, false);
  if (run.threadRole === 'ideas') return failIdeaBatch(ctx, run, finish, `The agent could not be started: ${message}`);
  if (run.threadRole === 'import') return failImportRun(ctx, run, finish, `The agent could not be started: ${message}`);
  if (run.threadRole === 'security') return failAuditRun(ctx, run, finish, `The agent could not be started: ${message}`);
  if (run.threadRole === 'knowledge') return failKnowledgeRun(ctx, run, finish, `The agent could not be started: ${message}`);
  if (run.threadRole === 'plan' && run.planId) {
    ctx.db.transaction((tx) => {
      finish(tx);
      tx.update(plans).set({ status: 'failed', error: message, attention: null, updatedAt: nowIso() }).where(eq(plans.id, run.planId!)).run();
      addEvent(tx, { boardId: run.boardId, planId: run.planId, runId: run.id, type: 'plan_failed', payload: { error: message } });
    });
    emitPlan(ctx, run.planId);
    return;
  }
  if (!run.taskId) {
    finish(ctx.db);
    return;
  }
  const event: TaskEvent = run.threadRole === 'review' ? { type: 'review.failed' } : { type: 'run.start_failed' };
  const r = transition(ctx, run.taskId, event, {
    runId: run.id,
    actor: 'system',
    payload: { error: message },
    patch: { lastMessage: message },
    also: finish,
  });
  if (!r.ok) {
    finish(ctx.db);
    emitTask(ctx, run.taskId);
  }
  if (r.ok && r.to === 'failed') notifyFailed(ctx, r.task, run.id, 'start failed');
  if (r.ok && r.to === 'human_review') ctx.notifier.notify({ type: 'human_review', boardId: r.task.boardId, taskId: r.task.id, dedupe: run.id, title: `#${r.task.number} ready for review (AI review failed)`, body: r.task.title });
}

export function notifyFailed(ctx: EngineContext, task: TaskRow, runId: string, why: string) {
  ctx.notifier.notify({ type: 'task_failed', boardId: task.boardId, taskId: task.id, dedupe: runId, title: `#${task.number} failed: ${why}`, body: task.title });
}

/** The run's thread is gone (spec §15.2). */
export function threadMissing(ctx: EngineContext, run: RunRow) {
  log.warn({ runId: run.id, threadId: run.threadId }, 'thread missing');
  const finish = (tx: DbOrTx) => finishRun(tx, run.id, { status: 'lost', error: 'thread no longer exists in T3' });
  if (run.threadRole === 'insight') {
    return failInsightAnswer(ctx, run, finish, "The chat's T3 thread no longer exists. Ask again to continue in a new thread.", true);
  }
  if (run.threadRole === 'ideas') return failIdeaBatch(ctx, run, finish, "The agent's T3 thread no longer exists.");
  if (run.threadRole === 'import') return failImportRun(ctx, run, finish, "The agent's T3 thread no longer exists.");
  if (run.threadRole === 'security') return failAuditRun(ctx, run, finish, "The audit's T3 thread no longer exists.");
  if (run.threadRole === 'knowledge') return failKnowledgeRun(ctx, run, finish, "The build's T3 thread no longer exists.");
  if (run.threadRole === 'plan' && run.planId) {
    ctx.db.transaction((tx) => {
      finish(tx);
      tx.update(plans).set({ status: 'failed', error: 'planner thread no longer exists in T3', attention: null, updatedAt: nowIso() }).where(eq(plans.id, run.planId!)).run();
    });
    emitPlan(ctx, run.planId);
    return;
  }
  if (!run.taskId) return finish(ctx.db);
  const r = transition(ctx, run.taskId, { type: 'thread.missing' }, { runId: run.id, actor: 'reconciler', also: finish, patch: { lastMessage: 'The T3 thread no longer exists.' } });
  if (!r.ok) finish(ctx.db);
  else notifyFailed(ctx, r.task, run.id, 'thread missing');
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

export function modelFor(board: BoardRow, task: TaskRow | null, role: ThreadRole, plannerModel?: string | null) {
  // Insights, Ideas, imports, security audits and knowledge builds read the codebase the way the planner does.
  if (role === 'plan' || role === 'insight' || role === 'ideas' || role === 'import' || role === 'security' || role === 'knowledge') {
    return { provider: board.defaultProvider, model: plannerModel || board.plannerModel || board.defaultModel };
  }
  if (role === 'review') return { provider: board.defaultProvider, model: board.reviewerModel || board.defaultModel };
  const provider = task?.providerOverride || board.defaultProvider;
  // The board's model belongs to the board's provider: a task moved to another one runs that provider's default.
  return { provider, model: task?.modelOverride || (provider === board.defaultProvider ? board.defaultModel : null) };
}

function depsForPrompt(ctx: EngineContext, task: TaskRow) {
  const rows = ctx.db
    .select({ num: tasks.number, title: tasks.title, summary: tasks.lastSummary })
    .from(taskDeps)
    .innerJoin(tasks, eq(tasks.id, taskDeps.dependsOnTaskId))
    .where(eq(taskDeps.taskId, task.id))
    .orderBy(asc(tasks.number))
    .all();
  return rows.map((r) => ({ num: r.num, title: r.title, summary: r.summary ?? '(no summary)' }));
}

/** Longest plan spec put into an implement prompt (characters). */
const MAX_PROMPT_SPEC = 20_000;

/** The agreed spec of the task's plan (spec-first plans only). */
function planSpecFor(ctx: EngineContext, task: TaskRow): { planNumber: number; planSpec: string } | null {
  if (!task.planId) return null;
  const plan = ctx.db.select({ number: plans.number }).from(plans).where(eq(plans.id, task.planId)).get();
  const spec = specText(latestSpecRound(specRoundRows(ctx.db, task.planId)))?.trim();
  if (!plan || !spec) return null;
  const planSpec = spec.length > MAX_PROMPT_SPEC ? `${spec.slice(0, MAX_PROMPT_SPEC)}\n\n(… the rest of the spec is cut)` : spec;
  return { planNumber: plan.number, planSpec };
}

export function implementPrompt(ctx: EngineContext, board: BoardRow, task: TaskRow, branch: string): string {
  return ctx.prompts.render('implement', {
    ...planSpecFor(ctx, task),
    num: task.number,
    boardName: board.name,
    branch,
    baseBranch: board.baseBranch,
    title: task.title,
    description: task.description || '(no description)',
    acceptanceCriteria: task.acceptanceCriteria,
    boardBrief: board.brief.trim() || '(empty)',
    deps: depsForPrompt(ctx, task),
    knowledge: knowledgeFor(ctx, board, taskFocus(task), 'task'),
    screenshotDir: screenshotDir(ctx.config.dataDir, task),
    designDir: nextDesignDir(ctx, task.id),
    designChoice: chosenDesign(ctx.db, ctx.config.dataDir, task.id),
  });
}

/** What a task's prompts look up in the knowledge graph by: its text and the paths it touches. */
function taskFocus(task: TaskRow) {
  return { text: [task.title, task.description, ...task.acceptanceCriteria].join('\n'), paths: task.touches };
}

/** Where the task's next round of design options goes (named in every prompt that may make one). */
export function nextDesignDir(ctx: EngineContext, taskId: string): string {
  return designDir(ctx.config.dataDir, taskId, nextDesignRound(ctx.db, taskId));
}

export function reviewTitle(board: BoardRow, task: TaskRow, round: number) {
  return `Review #${task.number} r${round}: ${task.title} ${reviewMarker(board.short, task.number, round)}`;
}

export function taskTitle(board: BoardRow, task: TaskRow) {
  return `#${task.number} ${task.title} ${taskMarker(board.short, task.number)}`;
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

export function requireHealthy(ctx: EngineContext) {
  if (!ctx.health.healthy()) {
    throw new AppError('T3_UNAVAILABLE', "T3 Code isn't running. Start the T3 app to continue.", 503, ctx.health.get());
  }
}

/** Starts the task thread in a new worktree (user.start / scheduler.start / user.retry_fresh). */
export async function startTaskThread(
  ctx: EngineContext,
  taskId: string,
  eventType: 'user.start' | 'scheduler.start' | 'user.retry_fresh',
  actor: 'user' | 'scheduler',
): Promise<TaskRow> {
  requireHealthy(ctx);
  const task0 = ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task0) throw new AppError('NOT_FOUND', 'task not found', 404);
  const board = ctx.db.select().from(boards).where(eq(boards.id, task0.boardId)).get()!;
  const attempt = eventType === 'user.retry_fresh' ? task0.attempt + 1 : task0.attempt;
  const task = { ...task0, attempt };
  const branch = taskBranchName(board.slug, task.number, task.title, attempt);
  const promptText = implementPrompt(ctx, board, task, branch);
  const { provider, model } = modelFor(board, task, 'task');
  let runId = '';
  const r = transition(ctx, taskId, { type: eventType }, {
    actor,
    payload: { branch, attempt },
    patch: {
      attempt,
      branch,
      threadId: null,
      threadLink: null,
      worktreePath: null,
      fixRound: 0,
      reviewRound: 0,
      resultMissing: false,
      lastResult: null,
      lastSummary: null,
      lastMessage: null,
      diffStat: null,
      prUrl: null,
      lastT3RunId: null,
      activitySinceReview: false,
    },
    also: (tx) => {
      // A fresh thread starts from scratch: earlier attempts' findings no longer apply.
      tx.update(reviewFindings)
        .set({ status: 'dismissed' })
        .where(and(eq(reviewFindings.taskId, taskId), eq(reviewFindings.status, 'open')))
        .run();
      runId = insertRun(tx, {
        boardId: board.id,
        taskId,
        kind: 'implement',
        threadRole: 'task',
        promptText,
        marker: taskMarker(board.short, task.number),
        launch: {
          project: board.projectPath,
          title: taskTitle(board, task),
          provider,
          model,
          worktree: { baseRef: board.baseBranch, branch },
        },
      }).id;
    },
  });
  if (!r.ok) throw new AppError('ILLEGAL_TRANSITION', `#${task.number} cannot be started from ${r.from}`, 409);
  await launchRun(ctx, runId);
  return ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
}

/** Sends a message to the task thread as a new run (fix/changes/resume/rebase/followup/pr). */
export async function sendTaskMessage(
  ctx: EngineContext,
  taskId: string,
  o: {
    kind: Exclude<RunKind, 'spec' | 'plan' | 'review' | 'implement' | 'insight' | 'ideas' | 'import' | 'security' | 'knowledge'>;
    message: string;
    event: TaskEvent;
    actor: 'user' | 'reconciler';
    round?: number | null;
    patch?: TaskPatch;
    payload?: Record<string, unknown>;
    /** Extra writes that commit with the stage change. */
    also?: (tx: DbOrTx) => void;
  },
): Promise<TaskRow> {
  requireHealthy(ctx);
  const task = ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new AppError('NOT_FOUND', 'task not found', 404);
  if (!task.threadId) throw new AppError('ILLEGAL_TRANSITION', `#${task.number} has no T3 thread; use Retry fresh`, 409);
  let baseline: string | null = null;
  let itemCount: number | null = null;
  try {
    const { thread } = await ctx.t3.show(task.threadId, { messages: 1 });
    baseline = thread.latestRunId;
    itemCount = thread.itemCount;
  } catch (err) {
    if (isNotFound(err)) throw new AppError('ILLEGAL_TRANSITION', `The T3 thread of #${task.number} no longer exists; use Retry fresh`, 409);
    throw new AppError('T3_UNAVAILABLE', `Could not read the T3 thread: ${errorMessage(err)}`, 503);
  }
  let runId = '';
  const r = transition(ctx, taskId, o.event, {
    actor: o.actor === 'user' ? 'user' : 'reconciler',
    payload: { kind: o.kind, ...o.payload },
    patch: { ...o.patch, lastT3RunId: baseline },
    also: (tx) => {
      o.also?.(tx);
      runId = insertRun(tx, {
        boardId: task.boardId,
        taskId,
        kind: o.kind,
        threadRole: 'task',
        round: o.round ?? null,
        promptText: o.message,
        threadId: task.threadId!,
        threadLink: task.threadLink,
        baselineRunId: baseline,
        startItemCount: itemCount,
      }).id;
    },
  });
  if (!r.ok) throw new AppError('ILLEGAL_TRANSITION', `${o.event.type} is not allowed from ${r.from}`, 409);
  await launchRun(ctx, runId);
  return ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
}

/** Builds the reviewer run for a task entering ai_review; call inside the transition's `also`. */
export function reviewRunFor(ctx: EngineContext, board: BoardRow, task: TaskRow): NewRun {
  const round = task.reviewRound + 1;
  // The last review's findings, only when a fix round was sent for them: a passing review's minor
  // findings, or a review followed only by a merge turn, has nothing to verify.
  const prev = ctx.db.$client
    .prepare(
      `SELECT f.severity, f.file, f.line, f.title, f.detail FROM review_findings f
       JOIN runs rr ON rr.id = f.run_id
       WHERE f.task_id = ? AND f.status = 'open' AND f.run_id = (
         SELECT r.id FROM runs r JOIN review_findings x ON x.run_id = r.id
         WHERE x.task_id = ? ORDER BY r.started_at DESC LIMIT 1)
       AND EXISTS (SELECT 1 FROM runs fx WHERE fx.task_id = f.task_id AND fx.kind = 'fix' AND fx.started_at >= rr.started_at)`,
    )
    .all(task.id, task.id) as Array<{ severity: string; file: string | null; line: number | null; title: string; detail: string }>;
  // What the implementer's latest turn says it ran, so the reviewer need not repeat slow suites.
  // A turn without a result block leaves lastResult from an older turn, which tested older code.
  const last = task.resultMissing ? null : ImplementResult.safeParse(task.lastResult);
  const testsRun = last?.success ? last.data.testsRun : [];
  const previousFindings = prev.length
    ? prev.map((f) => `- [${f.severity}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.title}: ${f.detail}`).join('\n')
    : '';
  const promptText = ctx.prompts.render('review', {
    num: task.number,
    title: task.title,
    round,
    worktreePath: task.worktreePath ?? '(unknown worktree: ask the user)',
    branch: task.branch ?? '(unknown)',
    baseBranch: board.baseBranch,
    description: task.description || '(no description)',
    acceptanceCriteria: task.acceptanceCriteria,
    previousFindings,
    testsRun,
    designChoice: chosenDesign(ctx.db, ctx.config.dataDir, task.id),
    securityReview: board.securityReview ? { brief: board.securityBrief.trim() } : null,
    knowledge: knowledgeFor(ctx, board, taskFocus(task), 'task'),
  });
  const { provider, model } = modelFor(board, task, 'review');
  return {
    boardId: board.id,
    taskId: task.id,
    kind: 'review',
    threadRole: 'review',
    round,
    promptText,
    marker: reviewMarker(board.short, task.number, round),
    launch: { project: board.projectPath, title: reviewTitle(board, task, round), provider, model },
  };
}

/** user.rerun_review: human_review → ai_review with a new reviewer thread. */
export async function rerunReview(ctx: EngineContext, taskId: string): Promise<TaskRow> {
  requireHealthy(ctx);
  const task = ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new AppError('NOT_FOUND', 'task not found', 404);
  const board = ctx.db.select().from(boards).where(eq(boards.id, task.boardId)).get()!;
  let runId = '';
  const spec = reviewRunFor(ctx, board, task);
  const r = transition(ctx, taskId, { type: 'user.rerun_review' }, {
    actor: 'user',
    patch: { reviewRound: spec.round! },
    also: (tx) => {
      runId = insertRun(tx, spec).id;
    },
  });
  if (!r.ok) throw new AppError('ILLEGAL_TRANSITION', `cannot re-run review from ${r.from}`, 409);
  await launchRun(ctx, runId);
  return ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
}

export function isRunStarted(run: Pick<RunRow, 't3RunId' | 'baselineRunId'>, latestRunId: string | null): boolean {
  if (!latestRunId) return false;
  if (run.t3RunId) {
    if (latestRunId === run.t3RunId) return true;
    const a = runOrdinal(latestRunId);
    const b = runOrdinal(run.t3RunId);
    if (a !== null && b !== null) return a >= b;
  }
  return latestRunId !== run.baselineRunId;
}
