// Plans (spec §5.2, §5.3): planner runs, user edits as versions, accept into tasks.
// Spec-first plans start with spec rounds (the planner drafts a spec and asks; the user answers
// here) and go on to tasks when the user clicks Generate tasks.
import {
  duplicateKeys,
  findCycle,
  MAX_PLAN_TASKS,
  PlanMilestone,
  PlanTask,
  type CreatePlanBody,
  type PlanAnswer,
  type PlanFromSpecBody,
  type PlanResult,
  type PlanStatus,
  type ProposalPatch,
  type RefinePlanBody,
} from '@t3-orchestra/shared';
import { z } from 'zod';
import { and, desc, eq, max } from 'drizzle-orm';
import { boards, planSpecRounds, planVersions, plans, runs, taskDeps, tasks, type BoardRow, type PlanRow, type PlanSpecRoundRow, type TaskRow } from '../db/schema.ts';
import { latestSpecRound, specRoundRows, specText } from '../db/views.ts';
import { knowledgeFor } from '../knowledge/service.ts';
import { firstLine, newId, nowIso, planMarker } from '../util.ts';
import { addEvent, AppError, emitBoard, emitPlan, emitTask, getBoardOrThrow, type DbOrTx, type EngineContext } from './context.ts';
import { emitMilestone, insertMilestone, listMilestones } from './milestones.ts';
import { insertRun, launchRun, modelFor, requireHealthy } from './runs.ts';

function getPlanOrThrow(ctx: EngineContext, id: string): PlanRow {
  const p = ctx.db.select().from(plans).where(eq(plans.id, id)).get();
  if (!p) throw new AppError('NOT_FOUND', `plan ${id} not found`, 404);
  return p;
}

/** The board's milestones with their goal and progress, for the planner ("(none yet)" when there are none). */
export function milestonesText(ctx: EngineContext, boardId: string): string {
  const rows = listMilestones(ctx.db, boardId);
  if (rows.length === 0) return '(none yet)';
  const live = ctx.db.select({ m: tasks.milestoneId, stage: tasks.stage }).from(tasks).where(eq(tasks.boardId, boardId)).all();
  return rows
    .map((m) => {
      const mine = live.filter((t) => t.m === m.id && t.stage !== 'discarded');
      const done = mine.filter((t) => t.stage === 'done').length;
      const goal = m.goal.trim() ? ` — ${firstLine(m.goal, 200)}` : '';
      return `- ${m.title}${goal} (${done}/${mine.length} tasks done)`;
    })
    .join('\n');
}

/** How many questions the planner may ask per spec round (the schema allows a few more). */
const SPEC_QUESTIONS_PER_ROUND = 6;

type PromptPlan = Pick<PlanRow, 'boardId' | 'prompt' | 'options'>;
type PromptBoard = Pick<BoardRow, 'id' | 'slug' | 'baseBranch' | 'brief' | 'contextInPrompts'>;

/** What the planner and the spec prompts share: the goal and the board around it. */
function goalContext(ctx: EngineContext, plan: PromptPlan, board: PromptBoard) {
  return {
    milestones: milestonesText(ctx, plan.boardId),
    baseBranch: board.baseBranch,
    maxTasks: plan.options.maxTasks,
    boardBrief: board.brief.trim() || '(empty)',
    knowledge: knowledgeFor(ctx, board, { text: [plan.prompt, plan.options.extraGuidance ?? ''].join('\n') }, 'plan'),
    prompt: plan.prompt,
    extraGuidance: plan.options.extraGuidance?.trim() || '',
  };
}

/** `spec`: the spec agreed with the user, when a fresh thread plans from it (retry). */
function plannerPrompt(ctx: EngineContext, plan: PromptPlan, board: PromptBoard, spec: string | null) {
  return ctx.prompts.render('planner', { ...goalContext(ctx, plan, board), askQuestions: plan.options.askQuestions && !spec, spec });
}

/** `draft`: the spec so far, when a fresh thread takes the spec over (retry). */
function specPrompt(ctx: EngineContext, plan: PromptPlan, board: PromptBoard, draft: string | null) {
  return ctx.prompts.render('spec', { ...goalContext(ctx, plan, board), maxQuestions: SPEC_QUESTIONS_PER_ROUND, draft });
}

/** What a fresh planner thread starts with: the spec (spec-first plans) or the tasks. */
type PlannerStart = { kind: 'spec'; draft: string | null } | { kind: 'plan'; spec: string | null };

/** Starts a fresh planner thread for the plan (create + retry). */
async function startPlanner(ctx: EngineContext, plan: PlanRow, start: PlannerStart): Promise<void> {
  const board = getBoardOrThrow(ctx, plan.boardId);
  const { provider, model } = modelFor(board, null, 'plan', plan.options.plannerModel);
  const marker = planMarker(board.short, plan.number);
  const promptText = start.kind === 'spec' ? specPrompt(ctx, plan, board, start.draft) : plannerPrompt(ctx, plan, board, start.spec);
  let runId = '';
  ctx.db.transaction((tx) => {
    tx.update(plans)
      .set({ status: start.kind === 'spec' ? 'speccing' : 'planning', attention: null, error: null, threadId: null, threadLink: null, correctionSent: false, updatedAt: nowIso() })
      .where(eq(plans.id, plan.id))
      .run();
    runId = insertRun(tx, {
      boardId: board.id,
      planId: plan.id,
      kind: start.kind,
      threadRole: 'plan',
      promptText,
      marker,
      launch: { project: board.projectPath, title: `Plan #${plan.number}: ${plan.title} ${marker}`, provider, model },
    }).id;
  });
  emitPlan(ctx, plan.id);
  await launchRun(ctx, runId);
}

/** Sends the next message to the plan's planner thread as a new run. */
async function messagePlanner(
  ctx: EngineContext,
  plan: PlanRow,
  o: { kind: 'spec' | 'plan'; status: PlanStatus; message: string; event: string; payload: Record<string, unknown>; also?: (tx: DbOrTx) => void },
): Promise<void> {
  if (!plan.threadId) throw new AppError('ILLEGAL_TRANSITION', 'the plan has no planner thread; retry it instead', 409);
  let baseline: string | null = null;
  try {
    baseline = (await ctx.t3.show(plan.threadId, { messages: 1 })).thread.latestRunId;
  } catch (err) {
    throw new AppError('T3_UNAVAILABLE', `Could not read the planner thread: ${(err as Error).message}`, 503);
  }
  let runId = '';
  ctx.db.transaction((tx) => {
    tx.update(plans).set({ status: o.status, error: null, correctionSent: false, updatedAt: nowIso() }).where(eq(plans.id, plan.id)).run();
    o.also?.(tx);
    runId = insertRun(tx, {
      boardId: plan.boardId,
      planId: plan.id,
      kind: o.kind,
      threadRole: 'plan',
      promptText: o.message,
      threadId: plan.threadId!,
      threadLink: plan.threadLink,
      baselineRunId: baseline,
    }).id;
    addEvent(tx, { boardId: plan.boardId, planId: plan.id, type: o.event, payload: o.payload });
  });
  emitPlan(ctx, plan.id);
  await launchRun(ctx, runId);
}

export async function createPlan(ctx: EngineContext, boardId: string, body: CreatePlanBody): Promise<PlanRow> {
  requireHealthy(ctx);
  const board = getBoardOrThrow(ctx, boardId);
  const now = nowIso();
  const plan: PlanRow = {
    id: newId(),
    boardId,
    number: board.nextPlanNumber,
    title: firstLine(body.prompt, 80) || `Plan ${board.nextPlanNumber}`,
    prompt: body.prompt,
    options: body.options,
    status: body.options.specFirst ? 'speccing' : 'planning',
    attention: null,
    threadId: null,
    threadLink: null,
    currentVersion: 0,
    correctionSent: false,
    acceptedKeys: [],
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  ctx.db.transaction((tx) => {
    tx.insert(plans).values(plan).run();
    tx.update(boards).set({ nextPlanNumber: board.nextPlanNumber + 1 }).where(eq(boards.id, boardId)).run();
    addEvent(tx, { boardId, planId: plan.id, type: 'plan_created', payload: { number: plan.number, title: plan.title } });
  });
  await startPlanner(ctx, plan, body.options.specFirst ? { kind: 'spec', draft: null } : { kind: 'plan', spec: null });
  return getPlanOrThrow(ctx, plan.id);
}

/**
 * A retry starts a fresh thread from the last good point: a spec-first plan whose tasks could not be
 * made plans from its spec; one whose spec round failed carries on from the spec so far.
 */
function retryStart(ctx: EngineContext, plan: PlanRow): PlannerStart {
  if (!plan.options.specFirst) return { kind: 'plan', spec: null };
  const spec = specText(latestSpecRound(specRoundRows(ctx.db, plan.id)));
  const last = ctx.db.select({ kind: runs.kind }).from(runs).where(eq(runs.planId, plan.id)).orderBy(desc(runs.startedAt)).get();
  return spec && last?.kind === 'plan' ? { kind: 'plan', spec } : { kind: 'spec', draft: spec };
}

export async function retryPlan(ctx: EngineContext, planId: string): Promise<PlanRow> {
  requireHealthy(ctx);
  const plan = getPlanOrThrow(ctx, planId);
  if (plan.status !== 'failed') throw new AppError('ILLEGAL_TRANSITION', `only failed plans can be retried (plan is ${plan.status})`, 409);
  await startPlanner(ctx, plan, retryStart(ctx, plan));
  return getPlanOrThrow(ctx, planId);
}

export async function refinePlan(ctx: EngineContext, planId: string, { feedback, answers }: RefinePlanBody): Promise<PlanRow> {
  requireHealthy(ctx);
  const plan = getPlanOrThrow(ctx, planId);
  if (!['ready', 'failed'].includes(plan.status)) throw new AppError('ILLEGAL_TRANSITION', `cannot refine a plan that is ${plan.status}`, 409);
  await messagePlanner(ctx, plan, {
    kind: 'plan',
    status: 'refining',
    message: ctx.prompts.render('plan-refine', { feedback, answers, maxTasks: plan.options.maxTasks }),
    event: 'plan_refine',
    payload: { feedback, answers },
  });
  return getPlanOrThrow(ctx, planId);
}

// ---------------------------------------------------------------------------
// Spec rounds (spec-first plans)
// ---------------------------------------------------------------------------

/** The round the user is answering; the spec can change while it waits for them or after a failed reply. */
function openSpecRound(ctx: EngineContext, plan: PlanRow): PlanSpecRoundRow {
  if (plan.status !== 'spec_review' && plan.status !== 'failed') {
    throw new AppError('ILLEGAL_TRANSITION', `the spec cannot change while the plan is ${plan.status}`, 409);
  }
  const round = latestSpecRound(specRoundRows(ctx.db, plan.id));
  if (!round) throw new AppError('ILLEGAL_TRANSITION', 'the plan has no spec yet; retry it instead', 409);
  return round;
}

/** Stores what the user sent for the round; sending it again (after a failed reply) adds to it. */
function recordReply(tx: DbOrTx, round: PlanSpecRoundRow, answers: PlanAnswer[], feedback: string): void {
  const asked = new Set(answers.map((a) => a.question));
  const merged = [...(round.answers ?? []).filter((a) => !asked.has(a.question)), ...answers];
  const note = [round.feedback, feedback].filter(Boolean).join('\n\n') || null;
  tx.update(planSpecRounds).set({ answers: merged, feedback: note }).where(eq(planSpecRounds.id, round.id)).run();
}

/** Sends answers and/or a note back; the planner updates the spec and may ask more. */
export async function refineSpec(ctx: EngineContext, planId: string, { feedback, answers }: RefinePlanBody): Promise<PlanRow> {
  requireHealthy(ctx);
  const plan = getPlanOrThrow(ctx, planId);
  const round = openSpecRound(ctx, plan);
  const answered = new Set(answers.map((a) => a.question));
  const message = ctx.prompts.render('spec-refine', {
    answers,
    skipped: round.questions.map((q) => q.question).filter((q) => !answered.has(q)),
    feedback,
    userSpec: round.userSpec,
    maxQuestions: SPEC_QUESTIONS_PER_ROUND,
  });
  await messagePlanner(ctx, plan, {
    kind: 'spec',
    status: 'speccing',
    message,
    event: 'spec_refine',
    payload: { round: round.round, answers: answers.length, feedback },
    also: (tx) => recordReply(tx, round, answers, feedback),
  });
  return getPlanOrThrow(ctx, planId);
}

/** Generate tasks: the planner splits the current spec (plus answers not sent yet) into tasks. */
export async function planFromSpec(ctx: EngineContext, planId: string, { feedback, answers }: PlanFromSpecBody): Promise<PlanRow> {
  requireHealthy(ctx);
  const plan = getPlanOrThrow(ctx, planId);
  const round = openSpecRound(ctx, plan);
  const message = ctx.prompts.render('spec-plan', {
    baseBranch: getBoardOrThrow(ctx, plan.boardId).baseBranch,
    answers,
    feedback,
    spec: specText(round),
    edited: round.userSpec !== null,
    milestones: milestonesText(ctx, plan.boardId),
    maxTasks: plan.options.maxTasks,
  });
  await messagePlanner(ctx, plan, {
    kind: 'plan',
    status: plan.currentVersion > 0 ? 'refining' : 'planning',
    message,
    event: 'spec_accepted',
    payload: { round: round.round, answers: answers.length, feedback },
    also: (tx) => recordReply(tx, round, answers, feedback),
  });
  return getPlanOrThrow(ctx, planId);
}

/** Saves the user's own version of the current spec (it goes to the planner with the next message). */
export function editSpec(ctx: EngineContext, planId: string, spec: string): void {
  const plan = getPlanOrThrow(ctx, planId);
  const round = openSpecRound(ctx, plan);
  const userSpec = spec.trim() === round.spec.trim() ? null : spec;
  ctx.db.update(planSpecRounds).set({ userSpec }).where(eq(planSpecRounds.id, round.id)).run();
  addEvent(ctx.db, { boardId: plan.boardId, planId, type: 'spec_edited', payload: { round: round.round, reverted: userSpec === null } });
  emitPlan(ctx, planId);
}

export function discardPlan(ctx: EngineContext, planId: string): PlanRow {
  const plan = getPlanOrThrow(ctx, planId);
  if (plan.status === 'accepted') throw new AppError('ILLEGAL_TRANSITION', 'the plan was already accepted', 409);
  ctx.db.update(plans).set({ status: 'discarded', attention: null, updatedAt: nowIso() }).where(eq(plans.id, planId)).run();
  addEvent(ctx.db, { boardId: plan.boardId, planId, type: 'plan_discarded' });
  emitPlan(ctx, planId);
  return getPlanOrThrow(ctx, planId);
}

// ---------------------------------------------------------------------------
// User edits of proposals
// ---------------------------------------------------------------------------

function currentResult(ctx: EngineContext, plan: PlanRow): PlanResult {
  const v = ctx.db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.planId, plan.id), eq(planVersions.version, plan.currentVersion)))
    .get();
  if (!v?.parsed) throw new AppError('ILLEGAL_TRANSITION', 'the plan has no proposals yet', 409);
  return v.parsed;
}

/** Stores edited proposals: updates the current version if it is a user version, else adds one. */
function saveUserVersion(ctx: EngineContext, plan: PlanRow, result: PlanResult): void {
  if (!['ready', 'failed'].includes(plan.status)) throw new AppError('ILLEGAL_TRANSITION', `cannot edit a plan that is ${plan.status}`, 409);
  const cur = ctx.db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.planId, plan.id), eq(planVersions.version, plan.currentVersion)))
    .get();
  const rawText = JSON.stringify(result, null, 2);
  ctx.db.transaction((tx) => {
    if (cur && cur.source === 'user') {
      tx.update(planVersions).set({ parsed: result, rawText }).where(eq(planVersions.id, cur.id)).run();
    } else {
      const top = tx.select({ v: max(planVersions.version) }).from(planVersions).where(eq(planVersions.planId, plan.id)).get();
      const version = (top?.v ?? 0) + 1;
      tx.insert(planVersions).values({ id: newId(), planId: plan.id, version, source: 'user', runId: null, rawText, parsed: result, validationErrors: null, createdAt: nowIso() }).run();
      tx.update(plans).set({ currentVersion: version }).where(eq(plans.id, plan.id)).run();
    }
    tx.update(plans).set({ status: 'ready', updatedAt: nowIso() }).where(eq(plans.id, plan.id)).run();
  });
  emitPlan(ctx, plan.id);
}

/** Edits are saved even if the graph is temporarily invalid (the UI shows live checks); task shape must be valid. */
const EditableResult = z.object({
  summary: z.string(),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  milestones: z.array(PlanMilestone).default([]),
  tasks: z.array(PlanTask).max(MAX_PLAN_TASKS),
});

function validateEdit(result: PlanResult): PlanResult {
  const parsed = EditableResult.safeParse(result);
  if (!parsed.success) throw new AppError('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 400, parsed.error.issues);
  return parsed.data;
}

export function patchProposal(ctx: EngineContext, planId: string, key: string, patch: ProposalPatch): void {
  const plan = getPlanOrThrow(ctx, planId);
  const result = structuredClone(currentResult(ctx, plan));
  const i = result.tasks.findIndex((t) => t.key === key);
  if (i < 0) throw new AppError('NOT_FOUND', `no proposal ${key}`, 404);
  result.tasks[i] = { ...result.tasks[i]!, ...patch, key };
  saveUserVersion(ctx, plan, validateEdit(result));
}

export function addProposal(ctx: EngineContext, planId: string, task: PlanTask): void {
  const plan = getPlanOrThrow(ctx, planId);
  const result = structuredClone(currentResult(ctx, plan));
  if (result.tasks.some((t) => t.key === task.key)) throw new AppError('VALIDATION', `key ${task.key} already exists`);
  result.tasks.push(task);
  saveUserVersion(ctx, plan, validateEdit(result));
}

export function deleteProposal(ctx: EngineContext, planId: string, key: string): void {
  const plan = getPlanOrThrow(ctx, planId);
  const result = structuredClone(currentResult(ctx, plan));
  result.tasks = result.tasks.filter((t) => t.key !== key).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== key) }));
  saveUserVersion(ctx, plan, validateEdit(result));
}

export function replaceProposals(ctx: EngineContext, planId: string, list: PlanTask[]): void {
  const plan = getPlanOrThrow(ctx, planId);
  const result = { ...structuredClone(currentResult(ctx, plan)), tasks: list };
  saveUserVersion(ctx, plan, validateEdit(result));
}

// ---------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------

export function acceptPlan(ctx: EngineContext, planId: string, keys?: string[]): { plan: PlanRow; tasks: TaskRow[] } {
  const plan = getPlanOrThrow(ctx, planId);
  if (plan.status !== 'ready') throw new AppError('ILLEGAL_TRANSITION', `only a ready plan can be accepted (plan is ${plan.status})`, 409);
  const board = getBoardOrThrow(ctx, plan.boardId);
  const result = currentResult(ctx, plan);
  const selected = keys?.length ? result.tasks.filter((t) => keys.includes(t.key)) : result.tasks;
  if (selected.length === 0) throw new AppError('VALIDATION', 'select at least one task');
  const selectedKeys = new Set(selected.map((t) => t.key));
  const missing = selected.flatMap((t) => t.dependsOn.filter((d) => !selectedKeys.has(d)).map((d) => `${t.key} depends on ${d}`));
  if (missing.length) throw new AppError('VALIDATION', `Also select the dependencies: ${missing.join(', ')}`, 400, { missing });

  const cycle = findCycle(selected);
  if (cycle) throw new AppError('DEP_CYCLE', `dependency cycle: ${cycle.join(' → ')}`, 400, { cycle });
  const dups = duplicateKeys(selected);
  if (dups.length) throw new AppError('VALIDATION', `duplicate keys: ${dups.join(', ')}`);

  const now = nowIso();
  const stage = board.acceptInto;
  const created: TaskRow[] = [];
  const newMilestones: string[] = [];
  ctx.db.transaction((tx) => {
    // Milestones: reuse the board's by title, create the rest in the plan's order.
    const milestoneIdByTitle = new Map<string, string>();
    const key = (title: string) => title.trim().toLowerCase();
    for (const m of listMilestones(tx, board.id)) milestoneIdByTitle.set(key(m.title), m.id);
    const wanted = [...(result.milestones ?? []).map((m) => m.title), ...selected.map((t) => t.milestone ?? '')].filter((t) => t.trim());
    for (const title of wanted) {
      if (milestoneIdByTitle.has(key(title)) || !selected.some((t) => t.milestone && key(t.milestone) === key(title))) continue;
      const goal = result.milestones?.find((m) => key(m.title) === key(title))?.goal ?? '';
      const row = insertMilestone(tx, board.id, { title, goal, planId: plan.id });
      milestoneIdByTitle.set(key(title), row.id);
      newMilestones.push(row.id);
    }

    const top = tx.select({ p: max(tasks.position) }).from(tasks).where(eq(tasks.boardId, board.id)).get();
    let position = (top?.p ?? 0) + 1024;
    let number = board.nextTaskNumber;
    const idByKey = new Map<string, string>();
    for (const t of selected) {
      const row: TaskRow = {
        id: newId(),
        boardId: board.id,
        number: number++,
        planId: plan.id,
        planKey: t.key,
        followUpOf: null,
        followUpText: null,
        milestoneId: t.milestone ? (milestoneIdByTitle.get(key(t.milestone)) ?? null) : null,
        dismissedFollowUps: [],
        title: t.title,
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria,
        category: t.category,
        complexity: t.complexity,
        priority: t.priority,
        touches: t.touches,
        position,
        stage,
        stageReason: null,
        attention: null,
        threadId: null,
        threadLink: null,
        branch: null,
        worktreePath: null,
        attempt: 1,
        fixRound: 0,
        reviewRound: 0,
        reviewScore: null,
        reviewScoreReason: null,
        skipAiReview: false,
        runNext: false,
        providerOverride: null,
        modelOverride: null,
        lastResult: null,
        lastSummary: null,
        lastMessage: null,
        resultMissing: false,
        prUrl: null,
        lastThreadStatus: null,
        lastItemCount: null,
        lastActivityAt: null,
        diffStat: null,
        startedAt: null,
        completedAt: null,
        activitySinceReview: false,
        lastT3RunId: null,
        createdAt: now,
        updatedAt: now,
      };
      position += 1024;
      tx.insert(tasks).values(row).run();
      idByKey.set(t.key, row.id);
      created.push(row);
      addEvent(tx, { boardId: board.id, taskId: row.id, planId: plan.id, type: 'stage_changed', payload: { event: 'plan.accepted', from: null, to: stage, actor: 'user', planKey: t.key } });
    }
    for (const t of selected) {
      for (const d of t.dependsOn) {
        tx.insert(taskDeps).values({ taskId: idByKey.get(t.key)!, dependsOnTaskId: idByKey.get(d)! }).run();
      }
    }
    const section = [
      `## Plan #${plan.number}: ${plan.title}`,
      result.summary.trim(),
      result.assumptions.length ? `Assumptions:\n${result.assumptions.map((a) => `- ${a}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const brief = board.brief.trim() ? `${board.brief.trim()}\n\n${section}` : section;
    tx.update(boards).set({ nextTaskNumber: number, brief, updatedAt: now }).where(eq(boards.id, board.id)).run();
    tx.update(plans).set({ status: 'accepted', acceptedKeys: [...selectedKeys], updatedAt: now }).where(eq(plans.id, plan.id)).run();
    addEvent(tx, { boardId: board.id, planId: plan.id, type: 'plan_accepted', payload: { keys: [...selectedKeys], into: stage } });
  });
  emitPlan(ctx, plan.id);
  for (const id of newMilestones) emitMilestone(ctx, id);
  for (const t of created) emitTask(ctx, t.id);
  emitBoard(ctx, board.id);
  ctx.kick();
  return { plan: getPlanOrThrow(ctx, planId), tasks: created };
}

export function listPlans(ctx: EngineContext, boardId: string, all: boolean): PlanRow[] {
  const rows = ctx.db.select().from(plans).where(eq(plans.boardId, boardId)).orderBy(desc(plans.number)).all();
  return all ? rows : rows.filter((p) => p.status !== 'discarded');
}
