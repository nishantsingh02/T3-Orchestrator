// Ideas: a read-only agent reads the board's project and proposes ideas of one category (security,
// performance…). Each generation is one T3 thread on the root checkout; its result block becomes idea
// cards, and "Add to board" turns a card into a Backlog task. The Marketing view's tasks are ideas
// with a marketing category: they also come as `do` tasks (done outside the code), with a draft.
import {
  IDEA_CATEGORY_LABELS,
  isMarketingCategory,
  MAX_IDEAS,
  type AnyIdeaCategory,
  type Category,
  type Complexity,
  type IdeaBatchStatus,
  type IdeaCategory,
  type IdeaDifficulty,
  type IdeaKind,
  type MarketingProposal,
  type MarketingResult,
  type RunStatus,
} from '@t3-orchestra/shared';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import { ideaBatches, ideas, tasks, type IdeaBatchRow, type IdeaRow, type RunRow, type TaskRow } from '../db/schema.ts';
import { boardIdeas } from '../db/views.ts';
import { childLog } from '../log.ts';
import { errorMessage, ideasMarker, newId, nowIso } from '../util.ts';
import { AppError, emitIdea, emitIdeaBatch, getBoardOrThrow, type EngineContext } from './context.ts';
import { openTasksText } from './insights.ts';
import { milestonesText } from './plans.ts';
import { marketingPrompt } from '../marketing/prompt.ts';
import { parseIdeasResult, parseMarketingResult } from './results.ts';
import { failIdeaBatch, finishRun, ideaBatchOfRun, insertRun, launchRun, modelFor, requireHealthy } from './runs.ts';
import { knowledgeFor } from '../knowledge/service.ts';
import { createTask } from './tasks.ts';

const log = childLog('ideas');

const OPEN: IdeaBatchStatus[] = ['generating', 'waiting'];
const MAX_EXISTING = 60;

/** What the agent looks for in each category (the prompt's Focus section). */
const GUIDES: Record<IdeaCategory, string> = {
  code_improvements:
    'Features and extensions the existing code makes easy: patterns that can be reused for something new, half-built paths worth finishing, and capabilities the architecture already supports but the product does not use yet. Think "what could this codebase do next with little new machinery", not refactors.',
  ui_ux:
    'The interface as a user meets it: confusing flows, missing loading, empty and error states, inconsistent components, unclear copy, accessibility (labels, focus, contrast, keyboard use), small screens, and polish that makes common tasks faster. Read the UI code and its styles, and name the screens and components.',
  documentation:
    'What a new contributor or user cannot learn without asking: missing or outdated README sections, setup and run steps, environment variables, API and config reference, architecture notes, and comments on code that is hard to follow. Check the existing docs against the code.',
  security:
    'Real risks in this code: unvalidated input, injection (SQL, shell, path), authentication and authorization gaps, secrets in code or logs, unsafe defaults (CORS, cookies, headers), and risky dependencies. Name the file and how it could be abused; skip theoretical issues the code is not exposed to.',
  performance:
    'Wasted time and resources: slow or repeated queries (N+1), work done on every request or render that could be cached or skipped, large bundles and unneeded dependencies, blocking I/O, missing indexes, and memory growth. Prefer the paths users hit often.',
  code_quality:
    'What makes the code harder to change safely: duplication, files or functions that do too much, unclear names, dead code, inconsistent patterns, weak typing, and missing tests on important logic. Each idea should leave the code clearly easier to work with, without changing behavior.',
};

/** The task category an idea becomes on the board. */
const TASK_CATEGORY: Record<AnyIdeaCategory, Category> = {
  code_improvements: 'feature',
  ui_ux: 'design',
  documentation: 'docs',
  security: 'bug',
  performance: 'refactor',
  code_quality: 'refactor',
  launch: 'docs',
  content: 'docs',
  seo: 'feature',
  social: 'docs',
  growth: 'feature',
  analytics: 'feature',
};

const COMPLEXITY: Record<IdeaDifficulty, Complexity> = { easy: 'small', medium: 'medium', hard: 'large' };

function getBatchOrThrow(ctx: EngineContext, id: string): IdeaBatchRow {
  const b = ctx.db.select().from(ideaBatches).where(eq(ideaBatches.id, id)).get();
  if (!b) throw new AppError('NOT_FOUND', `idea generation ${id} not found`, 404);
  return b;
}

function getIdeaOrThrow(ctx: EngineContext, id: string): IdeaRow {
  const i = ctx.db.select().from(ideas).where(eq(ideas.id, id)).get();
  if (!i) throw new AppError('NOT_FOUND', `idea ${id} not found`, 404);
  return i;
}

/** The category's earlier ideas, so the agent doesn't propose them again. */
function existingIdeasText(ctx: EngineContext, boardId: string, category: AnyIdeaCategory): string {
  const rows = ctx.db
    .select({ title: ideas.title, status: ideas.status, taskNumber: tasks.number })
    .from(ideas)
    .leftJoin(tasks, eq(tasks.id, ideas.taskId))
    .where(and(eq(ideas.boardId, boardId), eq(ideas.category, category)))
    .orderBy(desc(ideas.createdAt))
    .all();
  if (rows.length === 0) return '(none yet)';
  const lines = rows.slice(0, MAX_EXISTING).map((i) => {
    const state =
      i.status === 'added'
        ? i.taskNumber
          ? `on the board as #${i.taskNumber}`
          : 'on the board'
        : i.status === 'done'
          ? 'done by the team'
          : i.status === 'dismissed'
            ? 'dismissed by the user'
            : 'not added yet';
    return `- ${i.title} (${state})`;
  });
  if (rows.length > MAX_EXISTING) lines.push(`- … and ${rows.length - MAX_EXISTING} more`);
  return lines.join('\n');
}

function ideasPrompt(ctx: EngineContext, boardId: string, category: AnyIdeaCategory): string {
  if (isMarketingCategory(category)) return marketingPrompt(ctx, boardId, category, existingIdeasText(ctx, boardId, category));
  const board = getBoardOrThrow(ctx, boardId);
  return ctx.prompts.render('ideas', {
    projectPath: board.projectPath,
    baseBranch: board.baseBranch,
    categoryLabel: IDEA_CATEGORY_LABELS[category],
    categoryGuide: GUIDES[category as IdeaCategory],
    maxIdeas: MAX_IDEAS,
    boardBrief: board.brief.trim() || '(empty)',
    milestones: milestonesText(ctx, board.id),
    openTasks: openTasksText(ctx, board.id),
    existingIdeas: existingIdeasText(ctx, board.id, category),
    knowledge: knowledgeFor(ctx, board, { text: `${IDEA_CATEGORY_LABELS[category]}\n${GUIDES[category as IdeaCategory]}` }, 'work'),
  });
}

export function listIdeas(ctx: EngineContext, boardId: string) {
  getBoardOrThrow(ctx, boardId);
  return boardIdeas(ctx.db, boardId);
}

/** Starts a generation of `category` ideas; one at a time per category. */
export async function generateIdeas(ctx: EngineContext, boardId: string, category: AnyIdeaCategory): Promise<IdeaBatchRow> {
  requireHealthy(ctx);
  const board = getBoardOrThrow(ctx, boardId);
  const label = IDEA_CATEGORY_LABELS[category];
  const marketing = isMarketingCategory(category);
  const busy = ctx.db
    .select({ id: ideaBatches.id })
    .from(ideaBatches)
    .where(and(eq(ideaBatches.boardId, boardId), eq(ideaBatches.category, category), inArray(ideaBatches.status, OPEN)))
    .get();
  if (busy) throw new AppError('ILLEGAL_TRANSITION', `The agent is still generating ${marketing ? 'marketing tasks' : 'ideas'} for ${label}.`, 409);
  const { provider, model } = modelFor(board, null, 'ideas');
  const promptText = ideasPrompt(ctx, boardId, category);
  const now = nowIso();
  let batch!: IdeaBatchRow;
  ctx.db.transaction((tx) => {
    const top = tx.select({ n: max(ideaBatches.number) }).from(ideaBatches).where(eq(ideaBatches.boardId, boardId)).get();
    const number = (top?.n ?? 0) + 1;
    const marker = ideasMarker(board.short, number);
    const runId = insertRun(tx, {
      boardId,
      kind: 'ideas',
      threadRole: 'ideas',
      promptText,
      marker,
      launch: { project: board.projectPath, title: `${marketing ? 'Marketing' : 'Ideas'} #${number}: ${label} ${marker}`, provider, model },
    }).id;
    batch = {
      id: newId(),
      boardId,
      number,
      category,
      status: 'generating',
      threadId: null,
      threadLink: null,
      runId,
      correctionSent: false,
      summary: null,
      suggestedBrief: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    tx.insert(ideaBatches).values(batch).run();
  });
  emitIdeaBatch(ctx, batch.id);
  await launchRun(ctx, batch.runId!);
  // The reconciler may be on its idle interval: have it switch to the active one now.
  ctx.kick();
  return getBatchOrThrow(ctx, batch.id);
}

/** "Add to board": the idea becomes a Backlog task. */
export function addIdeaToBoard(ctx: EngineContext, ideaId: string): { idea: IdeaRow; task: TaskRow } {
  const idea = getIdeaOrThrow(ctx, ideaId);
  if (idea.kind === 'do') throw new AppError('ILLEGAL_TRANSITION', 'This is something to do outside the code: mark it done instead.', 409);
  if (idea.taskId) {
    const t = ctx.db.select({ number: tasks.number, stage: tasks.stage }).from(tasks).where(eq(tasks.id, idea.taskId)).get();
    if (t && t.stage !== 'discarded') throw new AppError('ILLEGAL_TRANSITION', `This idea is already #${t.number} on the board.`, 409);
  }
  const from = isMarketingCategory(idea.category) ? 'Marketing' : 'Ideas';
  const description = [
    idea.description.trim(),
    idea.details.trim(),
    idea.draft.trim() && `### Copy to use\n\n${idea.draft.trim()}`,
    `_From ${from} (${IDEA_CATEGORY_LABELS[idea.category]}): ${idea.impact} impact, ${idea.difficulty} to implement._`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const task = createTask(
    ctx,
    idea.boardId,
    {
      title: idea.title,
      description,
      acceptanceCriteria: idea.acceptanceCriteria,
      dependsOn: [],
      complexity: COMPLEXITY[idea.difficulty],
      category: TASK_CATEGORY[idea.category],
      priority: idea.impact,
      touches: idea.touches,
      providerOverride: null,
      modelOverride: null,
      skipAiReview: false,
      milestoneId: null,
    },
    { stage: 'backlog' },
  );
  ctx.db.update(ideas).set({ status: 'added', taskId: task.id, updatedAt: nowIso() }).where(eq(ideas.id, idea.id)).run();
  emitIdea(ctx, idea.id);
  return { idea: getIdeaOrThrow(ctx, idea.id), task };
}

/** Hides an idea (or brings it back with `undo`). Ideas already on the board (or done) stay. */
export function dismissIdea(ctx: EngineContext, ideaId: string, undo: boolean): IdeaRow {
  const idea = getIdeaOrThrow(ctx, ideaId);
  if (idea.status === 'added') throw new AppError('ILLEGAL_TRANSITION', 'This idea is already on the board.', 409);
  if (idea.status === 'done') throw new AppError('ILLEGAL_TRANSITION', 'This task is already done.', 409);
  const status = undo ? 'new' : 'dismissed';
  if (idea.status !== status) {
    ctx.db.update(ideas).set({ status, updatedAt: nowIso() }).where(eq(ideas.id, idea.id)).run();
    emitIdea(ctx, idea.id);
  }
  return getIdeaOrThrow(ctx, idea.id);
}

/** Marks a `do` task done (or open again with `undo`). */
export function markIdeaDone(ctx: EngineContext, ideaId: string, undo: boolean): IdeaRow {
  const idea = getIdeaOrThrow(ctx, ideaId);
  if (idea.kind !== 'do') throw new AppError('ILLEGAL_TRANSITION', 'This one is a change to the code: add it to the board instead.', 409);
  const status = undo ? 'new' : 'done';
  if (idea.status !== status) {
    ctx.db.update(ideas).set({ status, updatedAt: nowIso() }).where(eq(ideas.id, idea.id)).run();
    emitIdea(ctx, idea.id);
  }
  return getIdeaOrThrow(ctx, idea.id);
}

// ---------------------------------------------------------------------------
// Run lifecycle (called by the reconciler)
// ---------------------------------------------------------------------------

/** `waiting` while the agent waits for the user in T3 (it was told not to ask, but may). */
export function ideasAttention(ctx: EngineContext, run: RunRow, waiting: boolean): void {
  const batch = ideaBatchOfRun(ctx, run.id);
  if (!batch || !OPEN.includes(batch.status)) return;
  const status: IdeaBatchStatus = waiting ? 'waiting' : 'generating';
  if (batch.status === status) return;
  ctx.db.update(ideaBatches).set({ status, updatedAt: nowIso() }).where(eq(ideaBatches.id, batch.id)).run();
  emitIdeaBatch(ctx, batch.id);
}

/**
 * Turns the run's result block into ideas. An unusable block gets one correction message in the same
 * thread (like the planner's); a second one fails the generation.
 */
export async function finalizeIdeas(
  ctx: EngineContext,
  run: RunRow,
  o: { texts: string[]; runStatus: RunStatus; threadStatus: string; threadId: string; latestRunId: string | null },
): Promise<void> {
  const batch = ideaBatchOfRun(ctx, run.id);
  if (!batch || !OPEN.includes(batch.status)) return finishRun(ctx.db, run.id, { status: o.runStatus });
  const fail = (error: string, resultRaw: string | null = null) =>
    failIdeaBatch(ctx, run, (tx) => finishRun(tx, run.id, { status: o.runStatus, resultRaw, error }), error);

  if (o.runStatus !== 'completed') return fail(`The agent's run ended ${o.threadStatus.replace('_', ' ')}.`);

  const marketing = isMarketingCategory(batch.category);
  const parsed = marketing ? parseMarketingResult(o.texts) : parseIdeasResult(o.texts);
  if (parsed.ok) {
    const { summary } = parsed.value;
    const suggestedBrief = 'suggestedBrief' in parsed.value ? (parsed.value as MarketingResult).suggestedBrief.trim() || null : null;
    // The agent was given the earlier titles; drop exact repeats anyway.
    const known = new Set(
      ctx.db
        .select({ title: ideas.title })
        .from(ideas)
        .where(and(eq(ideas.boardId, batch.boardId), eq(ideas.category, batch.category)))
        .all()
        .map((i) => i.title.trim().toLowerCase()),
    );
    const fresh = parsed.value.ideas.filter((i) => {
      const key = i.title.trim().toLowerCase();
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    const now = nowIso();
    const ids: string[] = [];
    ctx.db.transaction((tx) => {
      finishRun(tx, run.id, { status: 'completed', resultRaw: parsed.raw, resultJson: parsed.value });
      for (const i of fresh) {
        const id = newId();
        ids.push(id);
        const m = marketing ? (i as MarketingProposal) : null;
        const kind: IdeaKind = m?.kind ?? 'build';
        tx.insert(ideas)
          .values({
            id,
            boardId: batch.boardId,
            batchId: batch.id,
            category: batch.category,
            kind,
            title: i.title,
            description: i.description,
            details: i.details,
            draft: m?.draft.trim() ?? '',
            acceptanceCriteria: i.acceptanceCriteria,
            touches: i.touches,
            impact: i.impact,
            difficulty: i.difficulty,
            status: 'new',
            taskId: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
      tx.update(ideaBatches)
        .set({ status: 'done', summary: summary.trim() || null, suggestedBrief, error: null, finishedAt: now, updatedAt: now })
        .where(eq(ideaBatches.id, batch.id))
        .run();
    });
    for (const id of ids) emitIdea(ctx, id);
    emitIdeaBatch(ctx, batch.id);
    log.info({ batchId: batch.id, category: batch.category, ideas: ids.length, repeats: parsed.value.ideas.length - fresh.length }, 'ideas generated');
    // A finished generation has nothing more to say: take its thread out of T3's active sidebar.
    if (ctx.settings.get().settleDoneThreads) {
      void ctx.t3.settleThreads([o.threadId]).catch((err) => log.warn({ batchId: batch.id, err: errorMessage(err) }, 'could not settle the ideas thread'));
    }
    return;
  }

  const errors = parsed.errors.join('; ');
  if (batch.correctionSent) return fail(`The agent's ideas were still unusable after one correction: ${errors}`, parsed.raw);

  let correctionRunId = '';
  ctx.db.transaction((tx) => {
    finishRun(tx, run.id, { status: 'completed', resultRaw: parsed.raw, error: errors });
    correctionRunId = insertRun(tx, {
      boardId: batch.boardId,
      kind: 'ideas',
      threadRole: 'ideas',
      promptText: ctx.prompts.render('ideas-correction', { errors }),
      threadId: o.threadId,
      threadLink: batch.threadLink,
      baselineRunId: o.latestRunId,
    }).id;
    tx.update(ideaBatches).set({ runId: correctionRunId, correctionSent: true, updatedAt: nowIso() }).where(eq(ideaBatches.id, batch.id)).run();
  });
  log.info({ batchId: batch.id, errors }, 'ideas result unusable; sent a correction');
  await launchRun(ctx, correctionRunId);
}
