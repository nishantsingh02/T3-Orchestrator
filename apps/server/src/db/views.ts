// Row → view-model mapping for the REST API and SSE.
import {
  columnFor,
  OPEN_RUN_STATUSES,
  SECURITY_SEVERITIES,
  SLOT_STAGES,
  type ActiveRunView,
  type BoardView,
  type Column,
  type DesignRoundView,
  type DesignSummaryView,
  type EventView,
  type FindingCounts,
  type FindingView,
  type BoardIdeasView,
  type IdeaBatchView,
  type IdeaView,
  type ImplementResult,
  type InsightChatDetailView,
  type InsightChatView,
  type InsightMessageView,
  type MilestoneView,
  type PlanDetailView,
  type PlanTask,
  type PlanVersionView,
  type PlanView,
  type ProjectImportView,
  type SpecRoundView,
  type RunView,
  type ScreenshotView,
  type SecurityOpenCounts,
  type Severity,
  type TaskDepView,
  type TaskDetailView,
  type TaskView,
} from '@t3-orchestra/shared';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import {
  boards,
  designRounds,
  events,
  ideaBatches,
  ideas,
  insightChats,
  insightMessages,
  plans,
  planSpecRounds,
  planVersions,
  projectImports,
  reviewFindings,
  runs,
  securityFindings,
  taskDeps,
  tasks,
  type BoardRow,
  type EventRow,
  type FindingRow,
  type IdeaBatchRow,
  type IdeaRow,
  type InsightChatRow,
  type InsightMessageRow,
  type MilestoneRow,
  type PlanRow,
  type PlanSpecRoundRow,
  type PlanVersionRow,
  type ProjectImportRow,
  type RunRow,
  type TaskRow,
} from './schema.ts';

export interface ViewCtx {
  staleAfterMinutes: number;
  now?: number;
  /** Background work an open run's ended turn waits on (kept in memory by the engine). */
  backgroundOf?: (runId: string) => string[];
}

function depViewsFor(db: Db, taskIds: string[]): Map<string, TaskDepView[]> {
  const out = new Map<string, TaskDepView[]>();
  if (taskIds.length === 0) return out;
  const rows = db
    .select({ taskId: taskDeps.taskId, id: tasks.id, number: tasks.number, title: tasks.title, stage: tasks.stage })
    .from(taskDeps)
    .innerJoin(tasks, eq(tasks.id, taskDeps.dependsOnTaskId))
    .where(inArray(taskDeps.taskId, taskIds))
    .orderBy(asc(tasks.number))
    .all();
  for (const r of rows) {
    const list = out.get(r.taskId) ?? [];
    list.push({ id: r.id, number: r.number, title: r.title, stage: r.stage });
    out.set(r.taskId, list);
  }
  return out;
}

function openRunsFor(db: Db, taskIds: string[]): Map<string, RunRow> {
  const out = new Map<string, RunRow>();
  if (taskIds.length === 0) return out;
  const rows = db
    .select()
    .from(runs)
    .where(and(inArray(runs.taskId, taskIds), inArray(runs.status, [...OPEN_RUN_STATUSES])))
    .orderBy(asc(runs.startedAt))
    .all();
  for (const r of rows) out.set(r.taskId!, r); // latest open run wins
  return out;
}

function findingCountsFor(db: Db, taskIds: string[]): Map<string, FindingCounts> {
  const out = new Map<string, FindingCounts>();
  if (taskIds.length === 0) return out;
  const rows = db
    .select({
      taskId: reviewFindings.taskId,
      severity: reviewFindings.severity,
      status: reviewFindings.status,
      runId: reviewFindings.runId,
      runStartedAt: runs.startedAt,
    })
    .from(reviewFindings)
    .innerJoin(runs, eq(runs.id, reviewFindings.runId))
    .where(inArray(reviewFindings.taskId, taskIds))
    .all();
  // Only the latest review run's findings count as current (rounds restart on Retry fresh).
  const latest = new Map<string, { runId: string; at: string }>();
  for (const r of rows) {
    const cur = latest.get(r.taskId);
    if (!cur || r.runStartedAt > cur.at) latest.set(r.taskId, { runId: r.runId, at: r.runStartedAt });
  }
  for (const r of rows) {
    if (r.runId !== latest.get(r.taskId)?.runId) continue;
    const c = out.get(r.taskId) ?? { open: {}, total: 0 };
    c.total++;
    if (r.status === 'open') c.open[r.severity as Severity] = (c.open[r.severity as Severity] ?? 0) + 1;
    out.set(r.taskId, c);
  }
  return out;
}

/** Each task's latest round of design options. */
function designSummariesFor(db: Db, taskIds: string[]): Map<string, DesignSummaryView> {
  const out = new Map<string, DesignSummaryView>();
  if (taskIds.length === 0) return out;
  const rows = db
    .select({ taskId: designRounds.taskId, round: designRounds.round, status: designRounds.status, options: designRounds.options })
    .from(designRounds)
    .where(inArray(designRounds.taskId, taskIds))
    .orderBy(asc(designRounds.round))
    .all();
  for (const r of rows) out.set(r.taskId, { round: r.round, status: r.status, options: r.options.length });
  return out;
}

function activeRunView(run: RunRow | undefined, task: TaskRow, background: string[]): ActiveRunView | null {
  if (!run) return null;
  return {
    id: run.id,
    kind: run.kind,
    round: run.round,
    status: run.status,
    threadId: run.threadId,
    threadLink: run.threadLink,
    startedAt: run.startedAt,
    events: Math.max(0, (task.lastItemCount ?? 0) - (run.startItemCount ?? task.lastItemCount ?? 0)),
    background,
  };
}

export function buildTaskViews(db: Db, rows: TaskRow[], ctx: ViewCtx): TaskView[] {
  const ids = rows.map((t) => t.id);
  const deps = depViewsFor(db, ids);
  const open = openRunsFor(db, ids);
  const findings = findingCountsFor(db, ids);
  const designs = designSummariesFor(db, ids);
  const now = ctx.now ?? Date.now();

  return rows.map((t) => {
    const d = deps.get(t.id) ?? [];
    const run = open.get(t.id);
    const background = run ? (ctx.backgroundOf?.(run.id) ?? []) : [];
    let quietMinutes: number | null = null;
    // A thread waiting on background work is quiet on purpose.
    if (run && (run.status === 'active' || run.status === 'waiting') && t.lastActivityAt && !background.length) {
      const mins = Math.floor((now - Date.parse(t.lastActivityAt)) / 60_000);
      if (mins >= ctx.staleAfterMinutes) quietMinutes = mins;
    }
    return {
      id: t.id,
      boardId: t.boardId,
      number: t.number,
      planId: t.planId,
      planKey: t.planKey,
      followUpOf: t.followUpOf,
      followUpText: t.followUpText,
      milestoneId: t.milestoneId,
      title: t.title,
      description: t.description,
      acceptanceCriteria: t.acceptanceCriteria,
      category: t.category,
      complexity: t.complexity,
      priority: t.priority,
      touches: t.touches,
      position: t.position,
      stage: t.stage,
      stageReason: t.stageReason,
      attention: t.attention,
      column: columnFor(t),
      threadId: t.threadId,
      threadLink: t.threadLink,
      branch: t.branch,
      worktreePath: t.worktreePath,
      fixRound: t.fixRound,
      reviewRound: t.reviewRound,
      reviewScore: t.reviewScore,
      reviewScoreReason: t.reviewScoreReason,
      skipAiReview: t.skipAiReview,
      runNext: t.runNext,
      providerOverride: t.providerOverride,
      modelOverride: t.modelOverride,
      lastSummary: t.lastSummary,
      lastMessage: t.lastMessage,
      resultMissing: t.resultMissing,
      prUrl: t.prUrl,
      lastThreadStatus: t.lastThreadStatus,
      lastActivityAt: t.lastActivityAt,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      activitySinceReview: t.activitySinceReview,
      deps: d,
      blockedBy: d.filter((x) => x.stage === 'failed' || x.stage === 'discarded'),
      waitingOn: d.filter((x) => x.stage !== 'done'),
      activeRun: activeRunView(run, t, background),
      findings: findings.get(t.id) ?? { open: {}, total: 0 },
      design: designs.get(t.id) ?? null,
      diffStat: t.diffStat ?? null,
      quietMinutes,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  });
}

export function taskView(db: Db, id: string, ctx: ViewCtx): TaskView | null {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return row ? buildTaskViews(db, [row], ctx)[0]! : null;
}

export function boardTaskViews(db: Db, boardId: string, ctx: ViewCtx & { includeDiscarded?: boolean }): TaskView[] {
  const where = ctx.includeDiscarded
    ? eq(tasks.boardId, boardId)
    : and(eq(tasks.boardId, boardId), ne(tasks.stage, 'discarded'));
  const rows = db.select().from(tasks).where(where).orderBy(asc(tasks.position), asc(tasks.number)).all();
  return buildTaskViews(db, rows, ctx);
}

export function runView(r: RunRow): RunView {
  const json = r.resultJson as Record<string, unknown> | null;
  return {
    id: r.id,
    kind: r.kind,
    threadId: r.threadId,
    threadLink: r.threadLink,
    threadRole: r.threadRole,
    round: r.round,
    status: r.status,
    promptText: r.promptText,
    resultRaw: r.resultRaw,
    resultJson: r.resultJson,
    summary: json && typeof json.summary === 'string' ? json.summary : null,
    error: r.error,
    external: r.external,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

export function milestoneView(m: MilestoneRow): MilestoneView {
  return {
    id: m.id,
    boardId: m.boardId,
    number: m.number,
    title: m.title,
    goal: m.goal,
    position: m.position,
    planId: m.planId,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

export function findingView(f: FindingRow): FindingView {
  return { ...f, file: f.file ?? null, line: f.line ?? null, suggestion: f.suggestion ?? null };
}

export function eventView(e: EventRow): EventView {
  return { ...e, payload: e.payload ?? {} };
}

export function taskDetailView(
  db: Db,
  id: string,
  ctx: ViewCtx,
  screenshotsOf: (task: { id: string; attempt: number }) => ScreenshotView[] = () => [],
  designsOf: (task: TaskView) => DesignRoundView[] = () => [],
): TaskDetailView | null {
  const base = taskView(db, id, ctx);
  if (!base) return null;
  const row = db.select({ lastResult: tasks.lastResult, attempt: tasks.attempt }).from(tasks).where(eq(tasks.id, id)).get();
  const runRows = db.select().from(runs).where(eq(runs.taskId, id)).orderBy(asc(runs.startedAt)).all();
  const findingRows = db.select().from(reviewFindings).where(eq(reviewFindings.taskId, id)).orderBy(desc(reviewFindings.round)).all();
  const eventRows = db.select().from(events).where(eq(events.taskId, id)).orderBy(desc(events.id)).limit(200).all();
  return {
    ...base,
    lastResult: (row?.lastResult as ImplementResult | null) ?? null,
    screenshots: row ? screenshotsOf({ id, attempt: row.attempt }) : [],
    designRounds: designsOf(base),
    runs: runRows.map(runView),
    findingsList: findingRows.map(findingView),
    events: eventRows.reverse().map(eventView),
  };
}

export function projectImportView(i: ProjectImportRow): ProjectImportView {
  return {
    id: i.id,
    number: i.number,
    status: i.status,
    threadCount: i.threadCount,
    threadsRead: i.threadsRead,
    threadLink: i.threadLink,
    summary: i.summary,
    nextSteps: i.nextSteps,
    text: i.text,
    error: i.error,
    createdAt: i.createdAt,
    finishedAt: i.finishedAt,
  };
}

/** Open security findings (not yet on the board, fixed or dismissed) by severity. */
export function securityOpenCounts(db: Pick<Db, 'select'>, boardId: string): SecurityOpenCounts {
  const counts = Object.fromEntries(SECURITY_SEVERITIES.map((s) => [s, 0])) as SecurityOpenCounts;
  const rows = db
    .select({ severity: securityFindings.severity })
    .from(securityFindings)
    .where(and(eq(securityFindings.boardId, boardId), eq(securityFindings.status, 'open')))
    .all();
  for (const r of rows) counts[r.severity]++;
  return counts;
}

export function boardView(db: Db, b: BoardRow): BoardView {
  const rows = db
    .select({ stage: tasks.stage, attention: tasks.attention })
    .from(tasks)
    .where(eq(tasks.boardId, b.id))
    .all();
  const byColumn: Partial<Record<Column, number>> = {};
  let active = 0;
  let needsYou = 0;
  let total = 0;
  for (const r of rows) {
    const col = columnFor(r);
    if (col === 'hidden') continue;
    total++;
    byColumn[col] = (byColumn[col] ?? 0) + 1;
    if (SLOT_STAGES.includes(r.stage)) active++;
    if (r.attention || r.stage === 'human_review') needsYou++;
  }
  const lastImport = db.select().from(projectImports).where(eq(projectImports.boardId, b.id)).orderBy(desc(projectImports.number)).limit(1).get();
  return {
    id: b.id,
    name: b.name,
    slug: b.slug,
    short: b.short,
    projectPath: b.projectPath,
    t3ProjectId: b.t3ProjectId,
    baseBranch: b.baseBranch,
    brief: b.brief,
    marketingBrief: b.marketingBrief,
    securityBrief: b.securityBrief,
    securityReview: b.securityReview,
    securityAutoScan: b.securityAutoScan,
    securityOpen: securityOpenCounts(db, b.id),
    contextAutoBuild: b.contextAutoBuild,
    contextInPrompts: b.contextInPrompts,
    autoRun: b.autoRun,
    maxParallel: b.maxParallel,
    acceptInto: b.acceptInto,
    aiReview: b.aiReview,
    skipReviewForTrivial: b.skipReviewForTrivial,
    maxFixRounds: b.maxFixRounds,
    reviewStrictness: b.reviewStrictness,
    avoidOverlap: b.avoidOverlap,
    mergeStrategy: b.mergeStrategy,
    defaultProvider: b.defaultProvider,
    defaultModel: b.defaultModel,
    plannerModel: b.plannerModel,
    reviewerModel: b.reviewerModel,
    autoApproveBelow: b.autoApproveBelow,
    nextTaskNumber: b.nextTaskNumber,
    observedRuntimeMode: b.observedRuntimeMode,
    runConfig: b.runConfig ?? null,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    archivedAt: b.archivedAt,
    counts: { total, active, needsYou, byColumn },
    projectImport: lastImport ? projectImportView(lastImport) : null,
  };
}

export function planView(p: PlanRow): PlanView {
  return {
    id: p.id,
    boardId: p.boardId,
    number: p.number,
    title: p.title,
    prompt: p.prompt,
    options: p.options,
    status: p.status,
    threadId: p.threadId,
    threadLink: p.threadLink,
    currentVersion: p.currentVersion,
    error: p.error,
    attention: p.attention,
    acceptedKeys: p.acceptedKeys,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function versionView(v: PlanVersionRow): PlanVersionView {
  return {
    id: v.id,
    version: v.version,
    source: v.source,
    runId: v.runId,
    rawText: v.rawText,
    parsed: v.parsed ?? null,
    validationErrors: v.validationErrors ?? null,
    createdAt: v.createdAt,
  };
}

function specRoundView(r: PlanSpecRoundRow): SpecRoundView {
  return {
    id: r.id,
    round: r.round,
    runId: r.runId,
    spec: r.spec,
    userSpec: r.userSpec,
    changes: r.changes,
    questions: r.questions,
    answers: r.answers,
    feedback: r.feedback,
    rawText: r.rawText,
    validationErrors: r.validationErrors,
    createdAt: r.createdAt,
  };
}

/** A plan's spec rounds, oldest first. */
export function specRoundRows(db: Db, planId: string): PlanSpecRoundRow[] {
  return db.select().from(planSpecRounds).where(eq(planSpecRounds.planId, planId)).orderBy(asc(planSpecRounds.round)).all();
}

/** The latest round the planner's reply could be used from (the one the user is answering). */
export const latestSpecRound = (rows: readonly PlanSpecRoundRow[]) => rows.findLast((r) => !r.validationErrors);

/** The current spec: the user's edit of the latest usable round, else the planner's. */
export function specText(row: PlanSpecRoundRow | undefined): string | null {
  return row ? (row.userSpec ?? row.spec) : null;
}

const taskSig = (t: PlanTask) => JSON.stringify({ ...t, key: undefined });

export function planDetailView(db: Db, p: PlanRow): PlanDetailView {
  const versionRows = db.select().from(planVersions).where(eq(planVersions.planId, p.id)).orderBy(asc(planVersions.version)).all();
  const valid = versionRows.filter((v) => v.parsed);
  const current = valid.find((v) => v.version === p.currentVersion) ?? valid.at(-1);
  const prev = current ? valid.filter((v) => v.version < current.version).at(-1) : undefined;
  const proposals = current?.parsed?.tasks ?? [];
  const prevByKey = new Map((prev?.parsed?.tasks ?? []).map((t) => [t.key, t]));
  const changedKeys: string[] = [];
  const addedKeys: string[] = [];
  if (prev) {
    for (const t of proposals) {
      const old = prevByKey.get(t.key);
      if (!old) addedKeys.push(t.key);
      else if (taskSig(old) !== taskSig(t)) changedKeys.push(t.key);
    }
  }
  const runRows = db.select().from(runs).where(eq(runs.planId, p.id)).orderBy(asc(runs.startedAt)).all();
  const specRows = specRoundRows(db, p.id);
  return {
    ...planView(p),
    versions: versionRows.map(versionView),
    proposals,
    changedKeys,
    addedKeys,
    specRounds: specRows.map(specRoundView),
    spec: specText(latestSpecRound(specRows)),
    runs: runRows.map(runView),
  };
}

export function getBoardRow(db: Db, idOrSlug: string): BoardRow | undefined {
  return (
    db.select().from(boards).where(eq(boards.id, idOrSlug)).get() ??
    db.select().from(boards).where(eq(boards.slug, idOrSlug)).get()
  );
}

export function getPlanRow(db: Db, id: string): PlanRow | undefined {
  return db.select().from(plans).where(eq(plans.id, id)).get();
}

export function insightMessageView(m: InsightMessageRow): InsightMessageView {
  return {
    id: m.id,
    chatId: m.chatId,
    boardId: m.boardId,
    seq: m.seq,
    role: m.role,
    text: m.text,
    notes: m.notes ?? [],
    status: m.status,
    error: m.error,
    createdAt: m.createdAt,
    finishedAt: m.finishedAt,
  };
}

function chatView(c: InsightChatRow, msgs: Array<Pick<InsightMessageRow, 'role' | 'text' | 'status'>>): InsightChatView {
  const lastAnswer = msgs.findLast((m) => m.role === 'assistant');
  const latest = msgs.findLast((m) => m.text.trim());
  const preview = (latest?.text ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  return {
    id: c.id,
    boardId: c.boardId,
    number: c.number,
    title: c.title,
    status: lastAnswer?.status ?? 'idle',
    threadLink: c.threadLink,
    messageCount: msgs.length,
    preview: preview.length > 160 ? `${preview.slice(0, 159)}…` : preview,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function getInsightChatRow(db: Db, id: string): InsightChatRow | undefined {
  return db.select().from(insightChats).where(eq(insightChats.id, id)).get();
}

function chatMessages(db: Db, chatId: string): InsightMessageRow[] {
  return db.select().from(insightMessages).where(eq(insightMessages.chatId, chatId)).orderBy(asc(insightMessages.seq)).all();
}

export function insightChatView(db: Db, c: InsightChatRow): InsightChatView {
  return chatView(c, chatMessages(db, c.id));
}

export function insightChatDetailView(db: Db, c: InsightChatRow): InsightChatDetailView {
  const msgs = chatMessages(db, c.id);
  return { ...chatView(c, msgs), messages: msgs.map(insightMessageView) };
}

/** The board's chats, most recently active first. */
export function boardInsightChats(db: Db, boardId: string): InsightChatView[] {
  const chats = db.select().from(insightChats).where(eq(insightChats.boardId, boardId)).orderBy(desc(insightChats.updatedAt)).all();
  if (chats.length === 0) return [];
  const msgs = db
    .select({ chatId: insightMessages.chatId, role: insightMessages.role, text: insightMessages.text, status: insightMessages.status })
    .from(insightMessages)
    .where(eq(insightMessages.boardId, boardId))
    .orderBy(asc(insightMessages.seq))
    .all();
  const byChat = new Map<string, typeof msgs>();
  for (const m of msgs) byChat.set(m.chatId, [...(byChat.get(m.chatId) ?? []), m]);
  return chats.map((c) => chatView(c, byChat.get(c.id) ?? []));
}

function ideaViewOf(i: IdeaRow, taskNumber: number | null): IdeaView {
  return {
    id: i.id,
    boardId: i.boardId,
    batchId: i.batchId,
    category: i.category,
    kind: i.kind,
    title: i.title,
    description: i.description,
    details: i.details,
    draft: i.draft,
    acceptanceCriteria: i.acceptanceCriteria ?? [],
    touches: i.touches ?? [],
    impact: i.impact,
    difficulty: i.difficulty,
    status: i.status,
    taskId: i.taskId,
    taskNumber,
    createdAt: i.createdAt,
  };
}

export function ideaView(db: Db, i: IdeaRow): IdeaView {
  const n = i.taskId ? db.select({ n: tasks.number }).from(tasks).where(eq(tasks.id, i.taskId)).get()?.n : undefined;
  return ideaViewOf(i, n ?? null);
}

function batchViewOf(b: IdeaBatchRow, ideaCount: number): IdeaBatchView {
  return {
    id: b.id,
    boardId: b.boardId,
    number: b.number,
    category: b.category,
    status: b.status,
    threadLink: b.threadLink,
    summary: b.summary,
    suggestedBrief: b.suggestedBrief,
    ideaCount,
    error: b.error,
    createdAt: b.createdAt,
    finishedAt: b.finishedAt,
  };
}

export function ideaBatchView(db: Db, b: IdeaBatchRow): IdeaBatchView {
  const count = db.select({ id: ideas.id }).from(ideas).where(eq(ideas.batchId, b.id)).all().length;
  return batchViewOf(b, count);
}

/** The board's idea generations, newest first, and its ideas that aren't dismissed, newest generation first. */
export function boardIdeas(db: Db, boardId: string): BoardIdeasView {
  const batches = db.select().from(ideaBatches).where(eq(ideaBatches.boardId, boardId)).orderBy(desc(ideaBatches.number)).all();
  // rowid: insert order, which is the agent's order (best first) within a generation.
  const rows = db.select().from(ideas).where(eq(ideas.boardId, boardId)).orderBy(sql`rowid`).all();
  const counts = new Map<string, number>();
  for (const i of rows) counts.set(i.batchId, (counts.get(i.batchId) ?? 0) + 1);
  const taskIds = rows.map((i) => i.taskId).filter((id): id is string => id !== null);
  const numbers = new Map(
    taskIds.length ? db.select({ id: tasks.id, n: tasks.number }).from(tasks).where(inArray(tasks.id, taskIds)).all().map((t) => [t.id, t.n]) : [],
  );
  const order = new Map(batches.map((b, i) => [b.id, i]));
  return {
    batches: batches.map((b) => batchViewOf(b, counts.get(b.id) ?? 0)),
    ideas: rows
      .filter((i) => i.status !== 'dismissed')
      .sort((a, b) => (order.get(a.batchId) ?? 0) - (order.get(b.batchId) ?? 0))
      .map((i) => ideaViewOf(i, i.taskId ? (numbers.get(i.taskId) ?? null) : null)),
  };
}
