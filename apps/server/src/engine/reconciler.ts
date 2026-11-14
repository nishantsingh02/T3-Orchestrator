// The status-sync loop (spec §8). One tick at a time; never overlapping.
import {
  isFinishedGroup,
  OPEN_RUN_STATUSES,
  runOrdinal,
  SEVERITY_RANK,
  threadStatusGroup,
  type FailedRunStatus,
  type ImplementResult,
  type RunStatus,
} from '@t3-orchestra/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { boards, insightChats, planSpecRounds, planVersions, plans, reviewFindings, runs, tasks, type BoardRow, type InsightChatRow, type PlanRow, type RunRow, type TaskRow } from '../db/schema.ts';
import * as git from '../git/git.ts';
import { childLog } from '../log.ts';
import { isNotFound, prStateOf, prUrlOf, T3CliError, type ThreadDetail, type ThreadMessage } from '../t3/T3Client.ts';
import { errorMessage, newId, nowIso } from '../util.ts';
import { autoApprove } from './actions.ts';
import { backgroundLabel } from './background.ts';
import { addEvent, emitPlan, emitTask, type DbOrTx, type EngineContext } from './context.ts';
import { collectOptions, designDir, insertDesignRound, nextDesignRound } from './designs.ts';
import { finalizeIdeas, ideasAttention } from './ideas.ts';
import { finalizeImport, importAttention } from './imports.ts';
import { finalizeKnowledge, knowledgeAttention } from './knowledge.ts';
import { adoptChatRuns, chatsToSync, finalizeInsight, insightAttention, insightProgress } from './insights.ts';
import { parseImplementResult, parsePlanResult, parseReviewResult, parseSpecResult } from './results.ts';
import { finalizeAudit, securityAttention } from './security.ts';
import { ThreadSettler } from './settle.ts';
import {
  finishRun,
  insertRun,
  launching,
  launchRun,
  notifyFailed,
  recordBoardFacts,
  recoverStartingRun,
  reviewRunFor,
  isRunStarted,
  threadMissing,
} from './runs.ts';
import { transition } from './transitions.ts';

const log = childLog('reconciler');

const BAD_TO_RUN_STATUS: Record<string, RunStatus> = {
  failed: 'failed',
  rolled_back: 'failed',
  interrupted: 'interrupted',
  cancelled: 'cancelled',
};

export class Reconciler {
  private ticking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** threadId → status|updatedAt|latestRunId seen on the last tick. */
  private readonly seen = new Map<string, string>();
  private readonly settler: ThreadSettler;

  constructor(
    private readonly ctx: EngineContext,
    private readonly afterTick: () => Promise<void> = async () => {},
  ) {
    this.settler = new ThreadSettler(ctx);
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Re-runs soon (e.g. after the user acted). */
  poke(): void {
    if (!this.stopped) this.schedule(250);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loopOnce(), ms);
  }

  private async loopOnce(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    await this.tick();
    await this.afterTick().catch((err) => log.error({ err }, 'afterTick failed'));
    // A poke during the pass already scheduled the next one.
    if (!this.stopped && !this.timer) this.schedule(this.intervalMs());
  }

  private intervalMs(): number {
    const s = this.ctx.settings.get();
    if (!this.ctx.health.healthy()) return s.pollIdleMs;
    const open = this.ctx.db.select({ id: runs.id }).from(runs).where(inArray(runs.status, [...OPEN_RUN_STATUSES])).limit(1).all();
    return open.length ? s.pollActiveMs : s.pollIdleMs;
  }

  /** One reconcile pass. Concurrent callers share the in-flight pass. */
  tick(): Promise<void> {
    this.ticking ??= this.doTick()
      .catch((err) => log.error({ err }, 'tick failed'))
      .finally(() => {
        this.ticking = null;
      });
    return this.ticking;
  }

  private async doTick(): Promise<void> {
    const { ctx } = this;
    if (!ctx.health.healthy()) {
      await ctx.health.check();
      if (!ctx.health.healthy()) return;
    }

    // 1. Runs left `starting` by a crash/outage (§15.3).
    const starting = ctx.db.select().from(runs).where(eq(runs.status, 'starting')).all();
    for (const r of starting) if (!launching.has(r.id)) await recoverStartingRun(ctx, r);

    // 2. Tracked runs, one `thread list` per board.
    const tracked = ctx.db
      .select()
      .from(runs)
      .where(and(inArray(runs.status, ['active', 'waiting']), isNotNull(runs.threadId)))
      .all()
      .filter((r) => !launching.has(r.id));
    ctx.background.newPass(new Set(tracked.map((r) => r.id)));
    const watchedTasks = ctx.db
      .select()
      .from(tasks)
      .where(and(inArray(tasks.stage, ['human_review', 'failed', 'done']), isNotNull(tasks.threadId)))
      .all();
    const chatBoards = ctx.db.selectDistinct({ boardId: insightChats.boardId }).from(insightChats).where(isNotNull(insightChats.threadId)).all();
    const boardIds = new Set([...tracked.map((r) => r.boardId), ...watchedTasks.map((t) => t.boardId), ...chatBoards.map((c) => c.boardId)]);

    for (const boardId of boardIds) {
      const board = ctx.db.select().from(boards).where(eq(boards.id, boardId)).get();
      if (!board || board.archivedAt) continue;
      let summaries;
      try {
        summaries = await ctx.t3.list(board.t3ProjectId ?? board.projectPath);
      } catch (err) {
        if (err instanceof T3CliError && err.unavailable) {
          await ctx.health.check();
          return;
        }
        log.warn({ boardId, err: errorMessage(err) }, 'thread list failed');
        continue;
      }
      const byId = new Map(summaries.map((s) => [s.threadId, s]));

      for (const run of tracked.filter((r) => r.boardId === boardId)) {
        try {
          await this.checkRun(run, byId.get(run.threadId!));
        } catch (err) {
          if (err instanceof T3CliError && err.unavailable) {
            await ctx.health.check();
            return;
          }
          log.error({ runId: run.id, err }, 'checkRun failed');
        }
      }

      // Runs started outside the app on settled tasks (§8).
      const open = new Set(
        ctx.db
          .select({ taskId: runs.taskId })
          .from(runs)
          .where(and(inArray(runs.status, [...OPEN_RUN_STATUSES]), eq(runs.boardId, boardId)))
          .all()
          .map((r) => r.taskId),
      );
      for (const task of watchedTasks.filter((t) => t.boardId === boardId && !open.has(t.id))) {
        const s = byId.get(task.threadId!);
        if (s) await this.checkSettledTask(board, task, s).catch((err) => log.warn({ taskId: task.id, err: errorMessage(err) }, 'settled-task check failed'));
      }

      for (const { chat, known } of chatsToSync(ctx, boardId, byId)) {
        await this.syncChat(chat, known).catch((err) => log.warn({ chatId: chat.id, err: errorMessage(err) }, 'chat sync failed'));
      }

      await this.settler.run(board, byId).catch((err) => log.warn({ boardId, err: errorMessage(err) }, 'settling done threads failed'));
    }
  }

  /** A chat thread with runs T3 Orchestra didn't start: adopt them, then evaluate them like any run. */
  private async syncChat(chat: InsightChatRow, known: number): Promise<void> {
    const { ctx } = this;
    const { thread, messages } = await ctx.t3.show(chat.threadId!, { messages: 50 });
    if (!thread.latestRunId) return;
    const ids = adoptChatRuns(ctx, chat, known, thread.latestRunId, messages);
    this.seen.delete(chat.threadId!);
    for (const id of ids) {
      const run = ctx.db.select().from(runs).where(eq(runs.id, id)).get();
      if (run) await this.evaluate(run, thread);
    }
  }

  private async checkRun(run: RunRow, summary: { status: string; updatedAt: string; latestRunId: string | null } | undefined) {
    const { ctx } = this;
    let shown: { thread: ThreadDetail; messages: ThreadMessage[] } | null = null;
    if (!summary) {
      try {
        shown = await ctx.t3.show(run.threadId!, { messages: 5 });
      } catch (err) {
        if (isNotFound(err)) {
          threadMissing(ctx, run);
          return;
        }
        throw err;
      }
    }
    const key = summary ? `${summary.status}|${summary.updatedAt}|${summary.latestRunId}` : null;
    // A turn waiting on background work is read again now and then, though its thread doesn't change.
    if (key && this.seen.get(run.threadId!) === key && !ctx.background.due(run.id)) return;
    shown ??= await ctx.t3.show(run.threadId!, { messages: 5 }).catch((err) => {
      if (isNotFound(err)) {
        threadMissing(ctx, run);
        return null;
      }
      throw err;
    });
    if (!shown) return;
    if (key) this.seen.set(run.threadId!, key);
    if (run.threadRole === 'insight' && isRunStarted(run, shown.thread.latestRunId)) insightProgress(ctx, run, runTexts(run, shown.messages).texts);
    await this.evaluate(run, shown.thread);
  }

  /** Updates cached fields and attention; finalizes the run when its thread finished. */
  async evaluate(run: RunRow, thread: ThreadDetail): Promise<void> {
    const { ctx } = this;
    recordBoardFacts(ctx, run.boardId, thread);
    const started = isRunStarted(run, thread.latestRunId);
    const group = threadStatusGroup(thread);
    const attention = group === 'attention' ? ('waiting' as const) : null;
    // T3 resumed the agent after its background work: it no longer waits on it.
    const resumed = !isFinishedGroup(group) && ctx.background.release(run.id);

    if (run.taskId) {
      const task = ctx.db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
      if (task) {
        const patch: Partial<TaskRow> = {
          lastThreadStatus: thread.status,
          lastActivityAt: thread.updatedAt,
          lastItemCount: thread.itemCount,
        };
        if (run.threadRole === 'task') {
          if (thread.worktreePath) patch.worktreePath = thread.worktreePath;
          if (thread.branch) patch.branch = thread.branch;
          if (thread.link && !task.threadLink) patch.threadLink = thread.link;
          const pr = prUrlOf(thread);
          if (pr) patch.prUrl = pr;
          patch.lastT3RunId = thread.latestRunId;
        }
        const activeStage = task.stage === 'implementing' || task.stage === 'ai_review';
        if (activeStage) patch.attention = attention;
        const changed = Object.entries(patch).some(([k, v]) => (task as Record<string, unknown>)[k] !== v);
        if (changed) {
          ctx.db.update(tasks).set({ ...patch, updatedAt: nowIso() }).where(eq(tasks.id, task.id)).run();
          if (activeStage && attention && !task.attention) {
            addEvent(ctx.db, { boardId: task.boardId, taskId: task.id, runId: run.id, type: 'attention_set', payload: { attention } });
            ctx.notifier.notify({ type: 'task_attention', boardId: task.boardId, taskId: task.id, dedupe: run.id, title: `#${task.number} ${task.title} needs your input`, body: 'The agent is waiting for you in T3.' });
          } else if (activeStage && !attention && task.attention) {
            addEvent(ctx.db, { boardId: task.boardId, taskId: task.id, runId: run.id, type: 'attention_cleared' });
          }
          emitTask(ctx, task.id);
        } else if (resumed) {
          emitTask(ctx, task.id);
        }
      }
    }

    if (run.planId) {
      const plan = ctx.db.select().from(plans).where(eq(plans.id, run.planId)).get();
      if (plan && ['speccing', 'planning', 'refining', 'needs_input'].includes(plan.status)) {
        const resting = run.kind === 'spec' ? 'speccing' : plan.currentVersion > 0 ? 'refining' : 'planning';
        const status = attention ? 'needs_input' : resting;
        if (plan.status !== status || plan.attention !== attention || (thread.link && !plan.threadLink)) {
          ctx.db
            .update(plans)
            .set({ status, attention, threadLink: plan.threadLink ?? thread.link, updatedAt: nowIso() })
            .where(eq(plans.id, plan.id))
            .run();
          if (attention && plan.status !== 'needs_input') {
            ctx.notifier.notify({ type: 'plan_input', boardId: plan.boardId, planId: plan.id, dedupe: run.id, title: `Planner needs your input: ${plan.title}` });
          }
          emitPlan(ctx, plan.id);
        }
      }
    }

    if (run.threadRole === 'insight' && started) insightAttention(ctx, run, attention !== null);
    if (run.threadRole === 'ideas' && started) ideasAttention(ctx, run, attention !== null);
    if (run.threadRole === 'import' && started) importAttention(ctx, run, attention !== null);
    if (run.threadRole === 'security' && started) securityAttention(ctx, run, attention !== null);
    if (run.threadRole === 'knowledge' && started) knowledgeAttention(ctx, run, attention !== null);

    const runStatus: RunStatus = attention ? 'waiting' : 'active';
    if (!isFinishedGroup(group) && run.status !== runStatus && started) {
      ctx.db.update(runs).set({ status: runStatus }).where(eq(runs.id, run.id)).run();
    }

    if (started && isFinishedGroup(group)) {
      if (group === 'finished_ok' && (await this.waitsInBackground(run, thread))) return;
      await this.finalize(run, thread, group === 'finished_bad');
    }
  }

  /**
   * True when the run's finished turn waits on background work the agent started (a long test run,
   * sub-agents): T3 resumes the agent once that work is done, and the run ends with that later turn.
   */
  private async waitsInBackground(run: RunRow, thread: ThreadDetail): Promise<boolean> {
    const { ctx } = this;
    const { work, changed } = await ctx.background.holding(run, thread);
    if (changed && run.taskId) {
      if (work.length) {
        addEvent(ctx.db, { boardId: run.boardId, taskId: run.taskId, runId: run.id, type: 'background_wait', payload: { message: work.map(backgroundLabel).join(', ') } });
      }
      emitTask(ctx, run.taskId);
    }
    return work.length > 0;
  }

  /** Assistant messages of every run after the baseline, oldest first (§8 step 4). */
  private async collectTexts(run: RunRow, threadId: string): Promise<RunTexts> {
    const baseOrd = baseOrdinal(run);
    let n = 20;
    for (;;) {
      const { messages } = await this.ctx.t3.show(threadId, { messages: n });
      const coversBaseline = messages.some((m) => {
        const o = runOrdinal(m.runId);
        return o !== null && o <= baseOrd;
      });
      if (messages.length < n || coversBaseline || n >= 2000) {
        return runTexts(run, messages);
      }
      n *= 4;
    }
  }

  private async finalize(run: RunRow, thread: ThreadDetail, bad: boolean): Promise<void> {
    const { texts, cut } = await this.collectTexts(run, thread.threadId);
    log.info({ runId: run.id, kind: run.kind, status: thread.status, messages: texts.length }, 'run finished');
    if (run.threadRole === 'plan') return run.kind === 'spec' ? this.finalizeSpec(run, thread, bad, texts) : this.finalizePlan(run, thread, bad, texts);
    if (run.threadRole === 'review') return this.finalizeReview(run, thread, bad, texts);
    if (run.threadRole === 'ideas') {
      return finalizeIdeas(this.ctx, run, {
        texts,
        runStatus: bad ? (BAD_TO_RUN_STATUS[thread.status] ?? 'failed') : 'completed',
        threadStatus: thread.status,
        threadId: thread.threadId,
        latestRunId: thread.latestRunId,
      });
    }
    if (run.threadRole === 'security') {
      return finalizeAudit(this.ctx, run, {
        texts,
        runStatus: bad ? (BAD_TO_RUN_STATUS[thread.status] ?? 'failed') : 'completed',
        threadStatus: thread.status,
        threadId: thread.threadId,
        latestRunId: thread.latestRunId,
      });
    }
    if (run.threadRole === 'knowledge') {
      return finalizeKnowledge(this.ctx, run, {
        texts,
        runStatus: bad ? (BAD_TO_RUN_STATUS[thread.status] ?? 'failed') : 'completed',
        threadStatus: thread.status,
        threadId: thread.threadId,
        latestRunId: thread.latestRunId,
      });
    }
    if (run.threadRole === 'import') {
      return finalizeImport(this.ctx, run, {
        texts,
        runStatus: bad ? (BAD_TO_RUN_STATUS[thread.status] ?? 'failed') : 'completed',
        threadStatus: thread.status,
        threadId: thread.threadId,
        latestRunId: thread.latestRunId,
      });
    }
    if (run.threadRole === 'insight') {
      return finalizeInsight(this.ctx, run, {
        texts,
        runStatus: bad ? (BAD_TO_RUN_STATUS[thread.status] ?? 'failed') : 'completed',
        threadStatus: thread.status,
        // Up to the next question when there is one (it gets its own answer), else everything so far.
        seenRunId: cut ? cut.lastRunId : thread.latestRunId,
      });
    }
    return this.finalizeTaskRun(run, thread, bad, texts);
  }

  private async finalizeTaskRun(run: RunRow, thread: ThreadDetail, bad: boolean, texts: string[]) {
    const { ctx } = this;
    const task = ctx.db.select().from(tasks).where(eq(tasks.id, run.taskId!)).get();
    if (!task) return finishRun(ctx.db, run.id, { status: 'completed' });
    const board = ctx.db.select().from(boards).where(eq(boards.id, task.boardId)).get()!;
    const lastMessage = texts.at(-1) ?? null;

    if (bad) {
      const status = BAD_TO_RUN_STATUS[thread.status] ?? 'failed';
      const r = transition(ctx, task.id, { type: 'run.failed', status: thread.status as FailedRunStatus }, {
        runId: run.id,
        actor: 'reconciler',
        patch: { lastMessage, lastThreadStatus: thread.status },
        also: (tx) => finishRun(tx, run.id, { status, error: `run ended ${thread.status}` }),
      });
      if (!r.ok) finishRun(ctx.db, run.id, { status });
      else notifyFailed(ctx, r.task, run.id, `run ${thread.status.replace('_', ' ')}`);
      return;
    }

    const parsed = parseImplementResult(texts);
    const resultRaw = parsed.raw;
    if (parsed.ok && parsed.value.status === 'blocked') {
      const v = parsed.value;
      const r = transition(ctx, task.id, { type: 'run.blocked' }, {
        runId: run.id,
        actor: 'reconciler',
        patch: { lastResult: v, lastSummary: v.summary, lastMessage: v.blockedReason || lastMessage, resultMissing: false },
        also: (tx) => finishRun(tx, run.id, { status: 'completed', resultRaw, resultJson: v }),
      });
      if (!r.ok) finishRun(ctx.db, run.id, { status: 'completed', resultRaw, resultJson: v });
      else notifyFailed(ctx, r.task, run.id, 'agent blocked');
      return;
    }
    if (parsed.ok && parsed.value.status === 'options' && run.kind !== 'pr') {
      return this.finalizeOptions(run, thread, task, parsed.value, parsed.raw, lastMessage);
    }

    const result = parsed.ok ? parsed.value : null;
    const patch: Partial<TaskRow> = {
      lastResult: result ?? task.lastResult,
      lastSummary: result?.summary ?? task.lastSummary,
      lastMessage,
      resultMissing: !parsed.ok,
      prUrl: prUrlOf(thread) ?? task.prUrl,
      worktreePath: thread.worktreePath ?? task.worktreePath,
      branch: thread.branch ?? task.branch,
      lastT3RunId: thread.latestRunId,
    };
    const finishSet = { status: 'completed' as const, resultRaw, resultJson: result, error: parsed.ok ? null : parsed.errors.join('; ') };

    if (run.kind === 'pr') {
      const r = transition(ctx, task.id, { type: 'run.done', skipReview: true, prRun: true }, {
        runId: run.id,
        actor: 'reconciler',
        patch: { ...patch, lastResult: task.lastResult, lastSummary: task.lastSummary },
        also: (tx) => finishRun(tx, run.id, finishSet),
      });
      if (!r.ok) return finishRun(ctx.db, run.id, finishSet);
      await this.afterHumanReview(r.task, run.id, patch.prUrl ? `PR opened` : 'PR run finished (no PR link found)');
      return;
    }

    const skipReview =
      !board.aiReview || task.skipAiReview || (task.complexity === 'trivial' && board.skipReviewForTrivial);
    let reviewRunId: string | null = null;
    const reviewSpec = skipReview ? null : reviewRunFor(ctx, board, { ...task, ...patch } as TaskRow);
    const r = transition(ctx, task.id, { type: 'run.done', skipReview }, {
      runId: run.id,
      actor: 'reconciler',
      patch: reviewSpec ? { ...patch, reviewRound: reviewSpec.round! } : patch,
      payload: { resultMissing: !parsed.ok },
      also: (tx) => {
        finishRun(tx, run.id, finishSet);
        if (reviewSpec) reviewRunId = insertRun(tx, reviewSpec).id;
      },
    });
    if (!r.ok) return finishRun(ctx.db, run.id, finishSet);
    if (r.to === 'ai_review' && reviewRunId) await launchRun(ctx, reviewRunId);
    if (r.to === 'human_review') await this.afterHumanReview(r.task, run.id, 'AI review skipped');
  }

  /**
   * The agent stopped before building and saved HTML design options: the task waits in Human Review
   * for the user's pick. The task's last result stays the last built one.
   */
  private finalizeOptions(run: RunRow, thread: ThreadDetail, task: TaskRow, v: ImplementResult, resultRaw: string, lastMessage: string | null) {
    const { ctx } = this;
    const round = nextDesignRound(ctx.db, task.id);
    const dir = designDir(ctx.config.dataDir, task.id, round);
    const options = collectOptions(dir, v.options);
    const finishSet = { status: 'completed' as const, resultRaw, resultJson: v };
    const patch = {
      worktreePath: thread.worktreePath ?? task.worktreePath,
      branch: thread.branch ?? task.branch,
      lastT3RunId: thread.latestRunId,
      resultMissing: false,
    };

    if (options.length === 0) {
      const reason = `The agent offered design options but saved no HTML page in ${dir}.`;
      const r = transition(ctx, task.id, { type: 'run.blocked' }, {
        runId: run.id,
        actor: 'reconciler',
        patch: { ...patch, lastMessage: reason },
        payload: { round, dir },
        also: (tx) => finishRun(tx, run.id, { ...finishSet, error: reason }),
      });
      if (!r.ok) finishRun(ctx.db, run.id, finishSet);
      else notifyFailed(ctx, r.task, run.id, 'no design options saved');
      return;
    }

    const question = v.question?.trim() || null;
    const r = transition(ctx, task.id, { type: 'run.options' }, {
      runId: run.id,
      actor: 'reconciler',
      patch: { ...patch, lastMessage },
      payload: { round, options: options.length },
      also: (tx) => {
        finishRun(tx, run.id, finishSet);
        insertDesignRound(tx, { taskId: task.id, runId: run.id, round, question, summary: v.summary.trim() || null, options });
      },
    });
    if (!r.ok) return finishRun(ctx.db, run.id, finishSet);
    ctx.notifier.notify({
      type: 'human_review',
      boardId: task.boardId,
      taskId: task.id,
      dedupe: run.id,
      title: `#${task.number} has ${options.length} design options for you to pick from`,
      body: question ?? task.title,
    });
  }

  private async finalizeReview(run: RunRow, thread: ThreadDetail, bad: boolean, texts: string[]) {
    const { ctx } = this;
    const task = ctx.db.select().from(tasks).where(eq(tasks.id, run.taskId!)).get();
    if (!task) return finishRun(ctx.db, run.id, { status: 'completed' });
    const board = ctx.db.select().from(boards).where(eq(boards.id, task.boardId)).get()!;

    const failReview = async (status: RunStatus, error: string, resultRaw: string | null) => {
      const r = transition(ctx, task.id, { type: 'review.failed' }, {
        runId: run.id,
        actor: 'reconciler',
        payload: { error },
        patch: { reviewScore: null, reviewScoreReason: null },
        also: (tx) => finishRun(tx, run.id, { status, error, resultRaw }),
      });
      if (!r.ok) finishRun(ctx.db, run.id, { status, error, resultRaw });
      else await this.afterHumanReview(r.task, run.id, 'AI review failed');
    };

    if (bad) return failReview(BAD_TO_RUN_STATUS[thread.status] ?? 'failed', `review run ended ${thread.status}`, null);
    const parsed = parseReviewResult(texts);
    if (!parsed.ok) return failReview('completed', parsed.errors.join('; '), parsed.raw);

    const review = parsed.value;
    const round = run.round ?? task.reviewRound;
    const limit = SEVERITY_RANK[board.reviewStrictness];
    const blocking = review.findings.filter((f) => SEVERITY_RANK[f.severity] <= limit);
    const storeFindings = (tx: DbOrTx) => {
      finishRun(tx, run.id, { status: 'completed', resultRaw: parsed.raw, resultJson: review });
      tx.update(reviewFindings)
        .set({ status: 'addressed' })
        .where(and(eq(reviewFindings.taskId, task.id), eq(reviewFindings.status, 'open')))
        .run();
      for (const f of review.findings) {
        tx.insert(reviewFindings)
          .values({
            id: newId(),
            taskId: task.id,
            runId: run.id,
            round,
            severity: f.severity,
            file: f.file ?? null,
            line: f.line ?? null,
            title: f.title,
            detail: f.detail ?? '',
            suggestion: f.suggestion ?? null,
            status: 'open',
          })
          .run();
      }
    };
    const score = review.humanReview?.score ?? null;
    const scorePatch = { reviewScore: score, reviewScoreReason: review.humanReview?.reason.trim() || null };
    const payload = { verdict: review.verdict, findings: review.findings.length, blocking: blocking.length, round, summary: review.summary, score };

    if (blocking.length === 0) {
      const r = transition(ctx, task.id, { type: 'review.pass' }, { runId: run.id, actor: 'reconciler', payload, patch: scorePatch, also: storeFindings });
      if (!r.ok) return storeFindings(ctx.db);
      const auto = await this.tryAutoApprove(r.task, board, score, run.id);
      if (auto === 'approved') return;
      await this.afterHumanReview(r.task, run.id, auto === 'failed' ? `AI passed ${score}/10, auto-approve failed` : 'AI passed');
      return;
    }

    let baseline: string | null = null;
    let itemCount: number | null = null;
    let threadOk = false;
    if (task.fixRound < board.maxFixRounds && task.threadId) {
      try {
        const { thread: tt } = await ctx.t3.show(task.threadId, { messages: 1 });
        baseline = tt.latestRunId;
        itemCount = tt.itemCount;
        threadOk = true;
      } catch (err) {
        log.warn({ taskId: task.id, err: errorMessage(err) }, 'task thread unreadable; not sending fix round');
      }
    }

    if (threadOk) {
      const fixRound = task.fixRound + 1;
      const message = ctx.prompts.render('fix', {
        num: task.number,
        round: fixRound,
        findings: review.findings.map((f) => ({ ...f, file: f.file ?? '(general)', line: f.line ?? null, suggestion: f.suggestion ?? null })),
      });
      let fixRunId = '';
      const r = transition(ctx, task.id, { type: 'review.changes', roundsLeft: true }, {
        runId: run.id,
        actor: 'reconciler',
        payload,
        patch: { fixRound, lastT3RunId: baseline },
        also: (tx) => {
          storeFindings(tx);
          fixRunId = insertRun(tx, {
            boardId: task.boardId,
            taskId: task.id,
            kind: 'fix',
            threadRole: 'task',
            round: fixRound,
            promptText: message,
            threadId: task.threadId!,
            threadLink: task.threadLink,
            baselineRunId: baseline,
            startItemCount: itemCount,
          }).id;
        },
      });
      if (!r.ok) return storeFindings(ctx.db);
      await launchRun(ctx, fixRunId);
      return;
    }

    const r = transition(ctx, task.id, { type: 'review.changes', roundsLeft: false }, { runId: run.id, actor: 'reconciler', payload, patch: scorePatch, also: storeFindings });
    if (!r.ok) return storeFindings(ctx.db);
    const counts = new Map<string, number>();
    for (const f of blocking) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
    const label = [...counts].map(([s, n]) => `${n} ${s}`).join(', ');
    await this.afterHumanReview(r.task, run.id, `${label} unresolved`);
  }

  /** The plan a finished planner run belongs to, or null when it is settled (the run is closed then). */
  private openPlanOf(run: RunRow, thread: ThreadDetail, bad: boolean): PlanRow | null {
    const { ctx } = this;
    const plan = ctx.db.select().from(plans).where(eq(plans.id, run.planId!)).get();
    if (!plan) {
      finishRun(ctx.db, run.id, { status: 'completed' });
      return null;
    }
    if (plan.status === 'discarded' || plan.status === 'accepted') {
      finishRun(ctx.db, run.id, { status: bad ? 'failed' : 'completed' });
      return null;
    }
    if (bad) {
      const status = BAD_TO_RUN_STATUS[thread.status] ?? 'failed';
      ctx.db.transaction((tx) => {
        finishRun(tx, run.id, { status, error: `planner run ended ${thread.status}` });
        tx.update(plans).set({ status: 'failed', attention: null, error: `Planner run ended ${thread.status}.`, updatedAt: nowIso() }).where(eq(plans.id, plan.id)).run();
      });
      emitPlan(ctx, plan.id);
      return null;
    }
    return plan;
  }

  /** An unusable planner reply: one automatic correction message, then the plan fails. */
  private async correctPlanner(run: RunRow, thread: ThreadDetail, plan: PlanRow, raw: string | null, errors: string[], what: string) {
    const { ctx } = this;
    if (!plan.correctionSent) {
      const message = ctx.prompts.render('plan-correction', { errors: errors.join('; ') });
      let correctionRunId = '';
      ctx.db.transaction((tx) => {
        finishRun(tx, run.id, { status: 'completed', resultRaw: raw, error: errors.join('; ') });
        tx.update(plans).set({ correctionSent: true, updatedAt: nowIso() }).where(eq(plans.id, plan.id)).run();
        correctionRunId = insertRun(tx, {
          boardId: plan.boardId,
          planId: plan.id,
          kind: run.kind,
          threadRole: 'plan',
          promptText: message,
          threadId: thread.threadId,
          threadLink: thread.link,
          baselineRunId: thread.latestRunId,
        }).id;
        addEvent(tx, { boardId: plan.boardId, planId: plan.id, runId: run.id, type: 'plan_correction_sent', payload: { errors } });
      });
      emitPlan(ctx, plan.id);
      await launchRun(ctx, correctionRunId);
      return;
    }

    ctx.db.transaction((tx) => {
      finishRun(tx, run.id, { status: 'completed', resultRaw: raw, error: errors.join('; ') });
      tx.update(plans)
        .set({ status: 'failed', attention: null, error: `The ${what} was still invalid after one correction: ${errors.join('; ')}`, updatedAt: nowIso() })
        .where(eq(plans.id, plan.id))
        .run();
    });
    emitPlan(ctx, plan.id);
  }

  private async finalizeSpec(run: RunRow, thread: ThreadDetail, bad: boolean, texts: string[]) {
    const { ctx } = this;
    const plan = this.openPlanOf(run, thread, bad);
    if (!plan) return;
    const lastText = texts.at(-1) ?? '';
    const parsed = parseSpecResult(texts);
    const top = ctx.db.$client.prepare('SELECT COALESCE(MAX(round), 0) AS r FROM plan_spec_rounds WHERE plan_id = ?').get(plan.id) as { r: number };
    const round = top.r + 1;
    const row = { id: newId(), planId: plan.id, round, runId: run.id, rawText: lastText, createdAt: nowIso() };

    if (parsed.ok) {
      const value = parsed.value;
      ctx.db.transaction((tx) => {
        finishRun(tx, run.id, { status: 'completed', resultRaw: parsed.raw, resultJson: value });
        tx.insert(planSpecRounds).values({ ...row, spec: value.spec, changes: value.changes, questions: value.questions }).run();
        tx.update(plans).set({ status: 'spec_review', attention: null, error: null, correctionSent: false, updatedAt: nowIso() }).where(eq(plans.id, plan.id)).run();
        addEvent(tx, { boardId: plan.boardId, planId: plan.id, runId: run.id, type: 'spec_round', payload: { round, questions: value.questions.length } });
      });
      emitPlan(ctx, plan.id);
      const n = value.questions.length;
      const name = plan.title.replace(/^#+\s*/, '');
      const title = n > 0 ? `Planner has ${n} ${n === 1 ? 'question' : 'questions'}: ${name}` : `Spec ready for review: ${name}`;
      ctx.notifier.notify({ type: 'plan_input', boardId: plan.boardId, planId: plan.id, dedupe: run.id, title });
      return;
    }

    ctx.db.insert(planSpecRounds).values({ ...row, validationErrors: parsed.errors }).run();
    await this.correctPlanner(run, thread, plan, parsed.raw, parsed.errors, "planner's spec");
  }

  private async finalizePlan(run: RunRow, thread: ThreadDetail, bad: boolean, texts: string[]) {
    const { ctx } = this;
    const plan = this.openPlanOf(run, thread, bad);
    if (!plan) return;
    const lastText = texts.at(-1) ?? '';

    let parsed = parsePlanResult(texts);
    if (parsed.ok && parsed.value.tasks.length > plan.options.maxTasks) {
      parsed = { ok: false, raw: parsed.raw, errors: [`too many tasks: ${parsed.value.tasks.length} (max ${plan.options.maxTasks})`], missing: false };
    }
    const maxVersion = ctx.db.$client.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM plan_versions WHERE plan_id = ?').get(plan.id) as { v: number };
    const version = maxVersion.v + 1;

    if (parsed.ok) {
      const value = parsed.value;
      ctx.db.transaction((tx) => {
        finishRun(tx, run.id, { status: 'completed', resultRaw: parsed.raw, resultJson: value });
        tx.insert(planVersions).values({ id: newId(), planId: plan.id, version, source: 'agent', runId: run.id, rawText: lastText, parsed: value, validationErrors: null, createdAt: nowIso() }).run();
        tx.update(plans).set({ status: 'ready', attention: null, currentVersion: version, error: null, correctionSent: false, updatedAt: nowIso() }).where(eq(plans.id, plan.id)).run();
        addEvent(tx, { boardId: plan.boardId, planId: plan.id, runId: run.id, type: 'plan_version', payload: { version, tasks: value.tasks.length } });
      });
      emitPlan(ctx, plan.id);
      ctx.notifier.notify({ type: 'plan_ready', boardId: plan.boardId, planId: plan.id, dedupe: run.id, title: `Plan ready: ${value.tasks.length} tasks proposed`, body: plan.title });
      return;
    }

    ctx.db.insert(planVersions).values({ id: newId(), planId: plan.id, version, source: 'agent', runId: run.id, rawText: lastText, parsed: null, validationErrors: parsed.errors, createdAt: nowIso() }).run();
    await this.correctPlanner(run, thread, plan, parsed.raw, parsed.errors, 'planner output');
  }

  /**
   * Approves an AI-passed task without the user when its review score is under the board's limit
   * (merges it like the Approve button, so dependent tasks can start). A failed attempt (merge
   * conflict, dirty root checkout, …) is logged and the task stays with the user.
   */
  private async tryAutoApprove(task: TaskRow, board: BoardRow, score: number | null, runId: string): Promise<'approved' | 'failed' | 'skipped'> {
    const below = board.autoApproveBelow;
    if (below == null || score == null || score >= below) return 'skipped';
    const { ctx } = this;
    await refreshDiffStat(ctx, task.id); // before the merge empties the branch's diff against base
    try {
      await autoApprove(ctx, task.id, score, below);
      log.info({ taskId: task.id, score, below }, 'auto-approved');
      return 'approved';
    } catch (err) {
      log.warn({ taskId: task.id, score, below, err: errorMessage(err) }, 'auto-approve failed');
      addEvent(ctx.db, { boardId: task.boardId, taskId: task.id, runId, type: 'auto_approve_failed', payload: { message: errorMessage(err), score, below } });
      emitTask(ctx, task.id);
      return 'failed';
    }
  }

  /** Diff stat + notification when a task lands in human_review. */
  private async afterHumanReview(task: TaskRow, runId: string, label: string) {
    await refreshDiffStat(this.ctx, task.id);
    this.ctx.notifier.notify({ type: 'human_review', boardId: task.boardId, taskId: task.id, dedupe: runId, title: `#${task.number} ready for review (${label})`, body: task.title });
  }

  private async checkSettledTask(board: BoardRow, task: TaskRow, s: { latestRunId: string | null; linkedPullRequest: unknown; pullRequests: unknown[] }) {
    const { ctx } = this;
    const set: Partial<TaskRow> = {};
    const pr = prUrlOf(s);
    if (pr && pr !== task.prUrl) set.prUrl = pr;
    let external = false;
    if (s.latestRunId && task.lastT3RunId && s.latestRunId !== task.lastT3RunId) {
      external = true;
      set.lastT3RunId = s.latestRunId;
      set.activitySinceReview = true;
    } else if (s.latestRunId && !task.lastT3RunId) {
      set.lastT3RunId = s.latestRunId;
    }
    if (Object.keys(set).length) {
      ctx.db.update(tasks).set({ ...set, updatedAt: nowIso() }).where(eq(tasks.id, task.id)).run();
      if (external) {
        addEvent(ctx.db, { boardId: board.id, taskId: task.id, type: 'external_activity', payload: { latestRunId: s.latestRunId } });
        await refreshDiffStat(ctx, task.id);
      }
      emitTask(ctx, task.id);
    }
    if (task.stage === 'human_review' && prStateOf(s) === 'merged') {
      transition(ctx, task.id, { type: 'pr.merged' }, { actor: 'reconciler', payload: { prUrl: pr } });
    }
  }
}

/** Ordinal of the last T3 run before this one. */
function baseOrdinal(run: RunRow): number {
  return run.t3RunId ? (runOrdinal(run.t3RunId) ?? 1) - 1 : (runOrdinal(run.baselineRunId) ?? 0);
}

interface RunTexts {
  texts: string[];
  /** Set when a chat answer stopped at the next question: the T3 run of the last message before it. */
  cut: { lastRunId: string | null } | null;
}

/**
 * The run's assistant messages among `messages` (every run after the baseline), oldest first. A chat
 * answer also takes the runs the agent started by itself after its question, up to the next question.
 */
function runTexts(run: RunRow, messages: ThreadMessage[]): RunTexts {
  const baseOrd = baseOrdinal(run);
  const texts: string[] = [];
  let lastRunId: string | null = null;
  for (const m of messages) {
    const o = runOrdinal(m.runId) ?? Infinity;
    if (o <= baseOrd) continue;
    if (run.threadRole === 'insight' && m.role === 'user' && o > baseOrd + 1) return { texts, cut: { lastRunId } };
    if (m.role === 'assistant') texts.push(m.text);
    lastRunId = m.runId ?? lastRunId;
  }
  return { texts, cut: null };
}

/** Recomputes the cached `+added −removed · files` for a task's branch (best effort). */
export async function refreshDiffStat(ctx: EngineContext, taskId: string): Promise<void> {
  const task = ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task?.worktreePath) return;
  const board = ctx.db.select().from(boards).where(eq(boards.id, task.boardId)).get();
  if (!board) return;
  try {
    const files = await git.diffFiles(task.worktreePath, board.baseBranch);
    ctx.db.update(tasks).set({ diffStat: git.summarize(files) }).where(eq(tasks.id, taskId)).run();
    emitTask(ctx, taskId);
  } catch (err) {
    log.debug({ taskId, err: errorMessage(err) }, 'diff stat failed');
  }
}
