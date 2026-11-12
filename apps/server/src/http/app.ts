// HTTP API (spec §11.3, §11.4, §16).
import fs from 'node:fs';
import path from 'node:path';
import {
  AcceptPlanBody,
  AddSuggestionsBody,
  CreateMilestoneBody,
  DismissSuggestionsBody,
  PatchMilestoneBody,
  CheckNewFolderBody,
  CreateBoardBody,
  CreatePlanBody,
  CreateMarketingSourceBody,
  CreateTaskBody,
  DismissIdeaBody,
  DismissSecurityFindingBody,
  EditSpecBody,
  FixRunBody,
  GenerateIdeasBody,
  InsightMessageBody,
  MarkFindingFixedBody,
  MAX_KNOWLEDGE_FILE_BYTES,
  MAX_KNOWLEDGE_FILE_MB,
  MetricValueBody,
  PatchBoardBody,
  PatchInsightChatBody,
  PatchMarketingSourceBody,
  PatchSettings,
  PatchTaskBody,
  PickFolderBody,
  PlanFromSpecBody,
  PlanTask,
  ProposalPatch,
  RefinePlanBody,
  ReplaceProposalsBody,
  SetupProjectBody,
  StartAuditBody,
  StartKnowledgeBuildBody,
  StartRunBody,
  StartScanBody,
  TASK_ACTIONS,
  TaskActionBody,
  UpdateContextFileBody,
  ValidateProjectBody,
  type ApiError,
  type TaskAction,
} from '@t3-orchestra/shared';
import { and, asc, eq, gt } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { events } from '../db/schema.ts';
import { boardStats } from '../db/stats.ts';
import {
  boardTaskViews,
  boardView,
  eventView,
  getBoardRow,
  getInsightChatRow,
  getPlanRow,
  ideaBatchView,
  ideaView,
  insightChatDetailView,
  insightChatView,
  milestoneView,
  planDetailView,
  planView,
  taskDetailView,
  taskView,
} from '../db/views.ts';
import { runAction } from '../engine/actions.ts';
import { addProjectToT3, archiveBoard, createBoard, exportBoard, listBoards, patchBoard, validateProject } from '../engine/boards.ts';
import { AppError, getTaskOrThrow, viewCtx } from '../engine/context.ts';
import { DESIGN_FILE_TYPES, designFilePath, designRoundViews } from '../engine/designs.ts';
import type { Engine } from '../engine/engine.ts';
import { addIdeaToBoard, dismissIdea, generateIdeas, listIdeas, markIdeaDone } from '../engine/ideas.ts';
import { beginImport, gatherImport, listT3Projects } from '../engine/imports.ts';
import { createChat, deleteChat, listChats, renameChat, sendChatMessage } from '../engine/insights.ts';
import { addSuggestions, boardSuggestions, createMilestone, deleteMilestone, dismissSuggestions, listMilestones, patchMilestone } from '../engine/milestones.ts';
import {
  acceptPlan,
  addProposal,
  createPlan,
  deleteProposal,
  discardPlan,
  editSpec,
  listPlans,
  patchProposal,
  planFromSpec,
  refinePlan,
  refineSpec,
  replaceProposals,
  retryPlan,
} from '../engine/plans.ts';
import { TEMPLATE_NAMES } from '../engine/prompts.ts';
import { handleMcp } from '../mcp/server.ts';
import { addSource, boardMarketing, logValue, refreshBoardSources, refreshSource, removeSource, sourceView, updateSource } from '../marketing/service.ts';
import { auditViewById, startAudit } from '../engine/security.ts';
import { addFindingToBoard, beginScan, boardSecurity, dismissFinding, findingView, markFindingFixed, scanView, securityReport } from '../security/service.ts';
import { continueBuilds, startBuild } from '../engine/knowledge.ts';
import { pathState } from '../git/git.ts';
import { contextFilePath, contextFolder, servedType } from '../knowledge/files.ts';
import { addFile, boardKnowledge, describeFile, getFileOrThrow, knowledgeBuildView, knowledgeFor, removeFile, syncFromProject } from '../knowledge/service.ts';
import { fixProjectRun } from '../project-run/fix.ts';
import { openProjectInVsCode, projectGithubUrl, runInfo, startProjectRun } from '../project-run/service.ts';
import { githubAccount } from '../project-setup/github.ts';
import { FolderPickerBusy, FolderPickerUnavailable, pickFolder } from '../project-setup/picker.ts';
import { checkNewFolder, setupProject } from '../project-setup/setup.ts';
import { listScreenshots, SCREENSHOT_TYPES, screenshotPath } from '../engine/screenshots.ts';
import { createFollowUp, createTask, patchTask } from '../engine/tasks.ts';
import { childLog } from '../log.ts';
import { CliT3Client } from '../t3/CliT3Client.ts';

const log = childLog('http');

export interface AppOptions {
  engine: Engine;
  port: number;
  webDistDir?: string | null;
}

function fail(c: Context, err: unknown) {
  if (err instanceof AppError) {
    const body: { ok: false; error: ApiError } = { ok: false, error: { code: err.code, message: err.message, details: err.details } };
    return c.json(body, err.status as 400);
  }
  if (err instanceof z.ZodError) {
    return c.json({ ok: false, error: { code: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), details: err.issues } }, 400);
  }
  log.error({ err }, 'unhandled error');
  return c.json({ ok: false, error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } }, 500);
}

async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AppError('VALIDATION', 'request body is not valid JSON');
    }
  }
  return schema.parse(raw);
}

/**
 * A raw request body, or null when it is over `max` bytes. A body that is too big is still read to the
 * end (and dropped): an answer sent mid-upload reaches the browser through the dev proxy as a reset
 * connection, shown as "Cannot reach the T3 Orchestra server".
 */
async function readUpload(req: Request, max: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  if (reader) {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      size += r.value.byteLength;
      if (size <= max) chunks.push(r.value);
    }
  }
  return size > max ? null : Buffer.concat(chunks);
}

export function createApp(o: AppOptions): Hono {
  const { engine } = o;
  const ctx = engine.ctx;
  const app = new Hono();
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);

  // DNS-rebinding guard + CSRF guard (spec §16).
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!allowedHosts.has(host)) return c.text('Forbidden host', 403);
    if (c.req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (c.req.header('x-t3orchestra') !== '1') return c.json({ ok: false, error: { code: 'VALIDATION', message: 'missing X-T3Orchestra header' } }, 403);
    }
    await next();
  });

  app.onError((err, c) => fail(c, err));

  const vc = () => viewCtx(ctx);
  const boardOr404 = (idOrSlug: string) => {
    const b = getBoardRow(ctx.db, idOrSlug);
    if (!b) throw new AppError('NOT_FOUND', `board ${idOrSlug} not found`, 404);
    return b;
  };
  const planOr404 = (id: string) => {
    const p = getPlanRow(ctx.db, id);
    if (!p) throw new AppError('NOT_FOUND', `plan ${id} not found`, 404);
    return p;
  };

  // ---- health & settings -----------------------------------------------------
  app.get('/api/health', (c) => c.json(ctx.health.get()));
  app.get('/api/settings', (c) => c.json(ctx.settings.get()));
  app.patch('/api/settings', async (c) => {
    const p = await body(c, PatchSettings);
    const next = ctx.settings.patch(p);
    if (p.t3CliPath !== undefined && ctx.t3 instanceof CliT3Client) {
      ctx.t3.resetLauncher();
      void ctx.health.check();
    }
    ctx.kick();
    return c.json(next);
  });
  app.get('/api/settings/info', (c) => {
    const launcher = ctx.t3 instanceof CliT3Client ? ctx.t3.getLauncher() : null;
    return c.json({
      dataDir: ctx.config.dataDir,
      port: ctx.config.port,
      publicUrl: ctx.config.publicUrl,
      fake: ctx.config.fakeT3,
      launcher: launcher ? { kind: launcher.kind, command: launcher.command, cliPath: launcher.cliPath } : null,
      promptsDir: ctx.config.promptsOverrideDir,
      overriddenPrompts: ctx.prompts.overridden(),
      templates: [...TEMPLATE_NAMES],
    });
  });
  app.post('/api/settings/test-connection', async (c) => {
    if (ctx.t3 instanceof CliT3Client) ctx.t3.resetLauncher();
    return c.json(await ctx.health.check());
  });
  app.get('/api/t3/models', async (c) => {
    try {
      return c.json(await ctx.t3.modelCatalog());
    } catch (err) {
      throw new AppError('T3_UNAVAILABLE', `could not read T3's providers: ${err instanceof Error ? err.message : String(err)}`, 503);
    }
  });
  app.get('/api/t3/projects', async (c) => {
    try {
      return c.json(await listT3Projects(ctx));
    } catch (err) {
      throw new AppError('T3_UNAVAILABLE', `could not read T3's projects: ${err instanceof Error ? err.message : String(err)}`, 503);
    }
  });
  app.post('/api/settings/open-prompts-dir', async (c) => {
    fs.mkdirSync(ctx.config.promptsOverrideDir, { recursive: true });
    const { default: open } = await import('open');
    await open(ctx.config.promptsOverrideDir);
    return c.json({ ok: true });
  });

  // ---- boards ----------------------------------------------------------------
  app.post('/api/validate-project', async (c) => {
    const b = await body(c, ValidateProjectBody);
    return c.json(await validateProject(ctx, b.projectPath, b.baseBranch));
  });
  app.post('/api/add-to-t3', async (c) => {
    const b = await body(c, ValidateProjectBody);
    return c.json(await addProjectToT3(ctx, b.projectPath, b.baseBranch));
  });
  // The OS's folder window, on the computer running T3 Orchestra; the request waits until the user closes it.
  app.post('/api/folders/pick', async (c) => {
    const b = await body(c, PickFolderBody);
    try {
      return c.json({ path: await pickFolder(b) });
    } catch (err) {
      if (err instanceof FolderPickerUnavailable) throw new AppError('NOT_FOUND', err.message, 501);
      if (err instanceof FolderPickerBusy) throw new AppError('VALIDATION', err.message, 409);
      throw err;
    }
  });
  app.post('/api/folders/check-new', async (c) => {
    const b = await body(c, CheckNewFolderBody);
    return c.json(checkNewFolder(b.parent, b.name));
  });
  app.get('/api/github/account', async (c) => c.json(await githubAccount(c.req.query('refresh') === '1')));
  app.post('/api/projects/setup', async (c) => c.json(await setupProject(ctx, await body(c, SetupProjectBody))));
  app.get('/api/boards', (c) => c.json(listBoards(ctx)));
  app.post('/api/boards', async (c) => {
    const b = await body(c, CreateBoardBody);
    const row = await createBoard(ctx, b);
    if (b.importFromT3) {
      // The board exists either way; a failed start shows on it, and Import again retries.
      try {
        void gatherImport(ctx, beginImport(ctx, row.id).id);
      } catch (err) {
        log.warn({ boardId: row.id, err: err instanceof Error ? err.message : String(err) }, 'could not start the import of a new board');
      }
    }
    return c.json(boardView(ctx.db, row), 201);
  });
  app.get('/api/boards/:id', (c) => c.json(boardView(ctx.db, boardOr404(c.req.param('id')))));
  app.patch('/api/boards/:id', async (c) => {
    const b = boardOr404(c.req.param('id'));
    const row = await patchBoard(ctx, b.id, await body(c, PatchBoardBody));
    return c.json(boardView(ctx.db, row));
  });
  app.delete('/api/boards/:id', (c) => {
    archiveBoard(ctx, boardOr404(c.req.param('id')).id);
    return c.json({ ok: true });
  });
  app.post('/api/boards/:id/import', (c) => {
    const b = boardOr404(c.req.param('id'));
    void gatherImport(ctx, beginImport(ctx, b.id).id);
    return c.json(boardView(ctx.db, boardOr404(b.id)));
  });
  app.post('/api/boards/:id/validate-project', async (c) => {
    const b = boardOr404(c.req.param('id'));
    return c.json(await validateProject(ctx, b.projectPath, b.baseBranch));
  });
  app.post('/api/boards/:id/add-to-t3', async (c) => {
    const b = boardOr404(c.req.param('id'));
    return c.json(await addProjectToT3(ctx, b.projectPath, b.baseBranch));
  });
  app.get('/api/boards/:id/stats', (c) => c.json(boardStats(ctx.db, boardOr404(c.req.param('id')).id)));
  app.get('/api/boards/:id/export', (c) => {
    const b = boardOr404(c.req.param('id'));
    c.header('Content-Disposition', `attachment; filename="t3orchestra-${b.slug}.json"`);
    return c.json(exportBoard(ctx, b.id));
  });

  // ---- plans -----------------------------------------------------------------
  app.get('/api/boards/:id/plans', (c) => {
    const b = boardOr404(c.req.param('id'));
    return c.json(listPlans(ctx, b.id, c.req.query('all') === '1').map(planView));
  });
  app.post('/api/boards/:id/plans', async (c) => {
    const b = boardOr404(c.req.param('id'));
    const plan = await createPlan(ctx, b.id, await body(c, CreatePlanBody));
    return c.json(planView(plan), 201);
  });
  app.get('/api/plans/:id', (c) => c.json(planDetailView(ctx.db, planOr404(c.req.param('id')))));
  app.patch('/api/plans/:id/proposals/:key', async (c) => {
    const id = c.req.param('id');
    patchProposal(ctx, id, c.req.param('key'), await body(c, ProposalPatch));
    return c.json(planDetailView(ctx.db, planOr404(id)));
  });
  app.post('/api/plans/:id/proposals', async (c) => {
    const id = c.req.param('id');
    addProposal(ctx, id, await body(c, PlanTask));
    return c.json(planDetailView(ctx.db, planOr404(id)));
  });
  app.delete('/api/plans/:id/proposals/:key', (c) => {
    const id = c.req.param('id');
    deleteProposal(ctx, id, c.req.param('key'));
    return c.json(planDetailView(ctx.db, planOr404(id)));
  });
  app.put('/api/plans/:id/proposals', async (c) => {
    const id = c.req.param('id');
    replaceProposals(ctx, id, (await body(c, ReplaceProposalsBody)).tasks);
    return c.json(planDetailView(ctx.db, planOr404(id)));
  });
  app.post('/api/plans/:id/refine', async (c) => {
    const plan = await refinePlan(ctx, c.req.param('id'), await body(c, RefinePlanBody));
    return c.json(planView(plan));
  });
  app.put('/api/plans/:id/spec', async (c) => {
    const id = c.req.param('id');
    editSpec(ctx, id, (await body(c, EditSpecBody)).spec);
    return c.json(planDetailView(ctx.db, planOr404(id)));
  });
  app.post('/api/plans/:id/spec/refine', async (c) => {
    const plan = await refineSpec(ctx, c.req.param('id'), await body(c, RefinePlanBody));
    return c.json(planView(plan));
  });
  app.post('/api/plans/:id/spec/plan', async (c) => {
    const plan = await planFromSpec(ctx, c.req.param('id'), await body(c, PlanFromSpecBody));
    return c.json(planView(plan));
  });
  app.post('/api/plans/:id/accept', async (c) => {
    const r = acceptPlan(ctx, c.req.param('id'), (await body(c, AcceptPlanBody)).keys);
    return c.json({ plan: planView(r.plan), tasks: r.tasks.map((t) => taskView(ctx.db, t.id, vc())!) });
  });
  app.post('/api/plans/:id/discard', (c) => c.json(planView(discardPlan(ctx, c.req.param('id')))));
  app.post('/api/plans/:id/retry', async (c) => c.json(planView(await retryPlan(ctx, c.req.param('id')))));

  // ---- milestones & suggestions --------------------------------------------------
  app.get('/api/boards/:id/milestones', (c) => c.json(listMilestones(ctx.db, boardOr404(c.req.param('id')).id).map(milestoneView)));
  app.post('/api/boards/:id/milestones', async (c) => {
    const b = boardOr404(c.req.param('id'));
    return c.json(milestoneView(createMilestone(ctx, b.id, await body(c, CreateMilestoneBody))), 201);
  });
  app.patch('/api/milestones/:id', async (c) => c.json(milestoneView(patchMilestone(ctx, c.req.param('id'), await body(c, PatchMilestoneBody)))));
  app.delete('/api/milestones/:id', (c) => {
    deleteMilestone(ctx, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get('/api/boards/:id/suggestions', (c) => c.json(boardSuggestions(ctx, boardOr404(c.req.param('id')).id)));
  app.post('/api/boards/:id/suggestions/add', async (c) => {
    const b = boardOr404(c.req.param('id'));
    const rows = addSuggestions(ctx, b.id, await body(c, AddSuggestionsBody));
    return c.json(rows.map((r) => taskView(ctx.db, r.id, vc())!), 201);
  });
  app.post('/api/boards/:id/suggestions/dismiss', async (c) => {
    dismissSuggestions(ctx, boardOr404(c.req.param('id')).id, await body(c, DismissSuggestionsBody));
    return c.json({ ok: true });
  });

  // ---- insights ------------------------------------------------------------------
  const chatOr404 = (id: string) => {
    const chat = getInsightChatRow(ctx.db, id);
    if (!chat) throw new AppError('NOT_FOUND', `chat ${id} not found`, 404);
    return chat;
  };
  app.get('/api/boards/:id/insights', (c) => c.json(listChats(ctx, boardOr404(c.req.param('id')).id)));
  app.post('/api/boards/:id/insights', async (c) => {
    const b = boardOr404(c.req.param('id'));
    const chat = await createChat(ctx, b.id, (await body(c, InsightMessageBody)).text);
    return c.json(insightChatDetailView(ctx.db, chat), 201);
  });
  app.get('/api/insights/:id', (c) => c.json(insightChatDetailView(ctx.db, chatOr404(c.req.param('id')))));
  app.post('/api/insights/:id/messages', async (c) => {
    const chat = await sendChatMessage(ctx, c.req.param('id'), (await body(c, InsightMessageBody)).text);
    return c.json(insightChatDetailView(ctx.db, chat));
  });
  app.patch('/api/insights/:id', async (c) => {
    const chat = renameChat(ctx, c.req.param('id'), (await body(c, PatchInsightChatBody)).title);
    return c.json(insightChatView(ctx.db, chat));
  });
  app.delete('/api/insights/:id', (c) => {
    deleteChat(ctx, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- ideas -------------------------------------------------------------------
  app.get('/api/boards/:id/ideas', (c) => c.json(listIdeas(ctx, boardOr404(c.req.param('id')).id)));
  app.post('/api/boards/:id/ideas', async (c) => {
    const b = boardOr404(c.req.param('id'));
    const batch = await generateIdeas(ctx, b.id, (await body(c, GenerateIdeasBody)).category);
    return c.json(ideaBatchView(ctx.db, batch), 201);
  });
  app.post('/api/ideas/:id/add', (c) => {
    const r = addIdeaToBoard(ctx, c.req.param('id'));
    return c.json({ idea: ideaView(ctx.db, r.idea), task: taskView(ctx.db, r.task.id, vc()) }, 201);
  });
  app.post('/api/ideas/:id/dismiss', async (c) => {
    const idea = dismissIdea(ctx, c.req.param('id'), (await body(c, DismissIdeaBody)).undo);
    return c.json(ideaView(ctx.db, idea));
  });
  app.post('/api/ideas/:id/done', async (c) => {
    const idea = markIdeaDone(ctx, c.req.param('id'), (await body(c, DismissIdeaBody)).undo);
    return c.json(ideaView(ctx.db, idea));
  });

  // ---- marketing metrics -----------------------------------------------------------
  app.get('/api/boards/:id/marketing', async (c) => c.json(await boardMarketing(ctx, boardOr404(c.req.param('id')).id)));
  app.post('/api/boards/:id/marketing/sources', async (c) => {
    const b = boardOr404(c.req.param('id'));
    const row = await addSource(ctx, b.id, await body(c, CreateMarketingSourceBody));
    return c.json(sourceView(ctx.db, row), 201);
  });
  app.post('/api/boards/:id/marketing/refresh', async (c) => {
    const rows = await refreshBoardSources(ctx, boardOr404(c.req.param('id')).id);
    return c.json(rows.map((r) => sourceView(ctx.db, r)));
  });
  app.patch('/api/marketing/sources/:id', async (c) => {
    const row = await updateSource(ctx, c.req.param('id'), await body(c, PatchMarketingSourceBody));
    return c.json(sourceView(ctx.db, row));
  });
  app.delete('/api/marketing/sources/:id', (c) => {
    removeSource(ctx, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/marketing/sources/:id/refresh', async (c) => c.json(sourceView(ctx.db, await refreshSource(ctx, c.req.param('id')))));
  app.post('/api/marketing/sources/:id/values', async (c) => {
    const row = logValue(ctx, c.req.param('id'), (await body(c, MetricValueBody)).value);
    return c.json(sourceView(ctx.db, row));
  });

  // ---- security ----------------------------------------------------------------
  app.get('/api/boards/:id/security', async (c) => c.json(await boardSecurity(ctx, boardOr404(c.req.param('id')).id)));
  app.get('/api/boards/:id/security/report', async (c) => {
    const { filename, text } = await securityReport(ctx, boardOr404(c.req.param('id')).id);
    return c.body(text, 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
  });
  app.post('/api/boards/:id/security/audits', async (c) => {
    const b = boardOr404(c.req.param('id'));
    const audit = await startAudit(ctx, b.id, await body(c, StartAuditBody));
    return c.json(auditViewById(ctx, audit.id), 201);
  });
  app.post('/api/boards/:id/security/scans', async (c) => {
    const b = boardOr404(c.req.param('id'));
    const { scan } = await beginScan(ctx, b.id, (await body(c, StartScanBody)).kind);
    return c.json(scanView(scan), 202);
  });
  app.post('/api/security/findings/:id/add', (c) => {
    const r = addFindingToBoard(ctx, c.req.param('id'));
    return c.json({ finding: findingView(ctx.db, r.finding), task: taskView(ctx.db, r.task.id, vc()) }, 201);
  });
  app.post('/api/security/findings/:id/dismiss', async (c) => {
    const f = dismissFinding(ctx, c.req.param('id'), await body(c, DismissSecurityFindingBody));
    return c.json(findingView(ctx.db, f));
  });
  app.post('/api/security/findings/:id/fixed', async (c) => {
    const f = markFindingFixed(ctx, c.req.param('id'), (await body(c, MarkFindingFixedBody)).undo);
    return c.json(findingView(ctx.db, f));
  });

  // ---- context files and the knowledge graph -------------------------------------
  app.get('/api/boards/:id/context', async (c) => {
    const b = boardOr404(c.req.param('id'));
    // Files put in the project folder by hand (or pulled in) are read like uploads.
    if (syncFromProject(ctx, b.id).newPending) void continueBuilds(ctx, b.id, { onlyIfAuto: true });
    const git = await pathState(b.projectPath, contextFolder(b.projectPath)).catch(() => null);
    return c.json({ ...boardKnowledge(ctx, b.id), git });
  });
  // The file is the raw request body; its name and the user's description of it (left out: kept as
  // it is) come in the query.
  app.put('/api/boards/:id/context/files', async (c) => {
    const b = boardOr404(c.req.param('id'));
    const data = await readUpload(c.req.raw, MAX_KNOWLEDGE_FILE_BYTES);
    if (!data) throw new AppError('VALIDATION', `The file is larger than ${MAX_KNOWLEDGE_FILE_MB} MB.`, 413);
    return c.json(addFile(ctx, b.id, c.req.query('name') ?? '', data, c.req.query('description')), 201);
  });
  app.patch('/api/context/files/:id', async (c) => {
    return c.json(describeFile(ctx, c.req.param('id'), await body(c, UpdateContextFileBody)));
  });
  app.post('/api/boards/:id/context/builds', async (c) => {
    const b = boardOr404(c.req.param('id'));
    const build = await startBuild(ctx, b.id, await body(c, StartKnowledgeBuildBody));
    return c.json(knowledgeBuildView(build), 201);
  });
  // After an upload: starts a build when the board builds on its own and none is running.
  app.post('/api/boards/:id/context/auto-build', async (c) => {
    const build = await continueBuilds(ctx, boardOr404(c.req.param('id')).id, { onlyIfAuto: true });
    return c.json({ build: build ? knowledgeBuildView(build) : null });
  });
  // What an agent working on `q` would read (the page's "What agents see").
  app.get('/api/boards/:id/context/preview', (c) => {
    const b = boardOr404(c.req.param('id'));
    return c.json({ text: knowledgeFor(ctx, { ...b, contextInPrompts: true }, { text: c.req.query('q') ?? '' }, 'task') });
  });
  app.get('/api/context/files/:id/raw', (c) => {
    const f = getFileOrThrow(ctx, c.req.param('id'));
    const file = contextFilePath(boardOr404(f.boardId).projectPath, f.name);
    if (!fs.existsSync(file)) throw new AppError('NOT_FOUND', `${f.name} is missing from ${path.dirname(file)}`, 404);
    const { type, inline } = servedType(f.name);
    c.header('Content-Type', type);
    c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    c.header('X-Content-Type-Options', 'nosniff');
    // Uploaded content never runs as this origin (the browser's PDF viewer won't open in a sandbox).
    if (type !== 'application/pdf') c.header('Content-Security-Policy', 'sandbox');
    c.header('Referrer-Policy', 'no-referrer');
    // The URL carries the content hash, so a replaced file gets a new URL.
    c.header('Cache-Control', c.req.query('v') ? 'private, max-age=31536000, immutable' : 'no-cache');
    return c.body(fs.readFileSync(file));
  });
  app.delete('/api/context/files/:id', (c) => {
    removeFile(ctx, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- tasks -----------------------------------------------------------------
  app.get('/api/boards/:id/tasks', (c) => {
    const b = boardOr404(c.req.param('id'));
    return c.json(boardTaskViews(ctx.db, b.id, { ...vc(), includeDiscarded: c.req.query('discarded') === '1' }));
  });
  app.post('/api/boards/:id/tasks', async (c) => {
    const b = boardOr404(c.req.param('id'));
    const row = createTask(ctx, b.id, await body(c, CreateTaskBody));
    return c.json(taskView(ctx.db, row.id, vc()), 201);
  });
  app.get('/api/tasks/:id', (c) => {
    const v = taskDetailView(
      ctx.db,
      c.req.param('id'),
      vc(),
      (t) => listScreenshots(ctx.config.dataDir, t),
      (t) => designRoundViews(ctx.db, ctx.config.dataDir, t),
    );
    if (!v) throw new AppError('NOT_FOUND', 'task not found', 404);
    return c.json(v);
  });
  app.get('/api/tasks/:id/designs/:round/:name', (c) => {
    const task = getTaskOrThrow(ctx, c.req.param('id'));
    const file = designFilePath(ctx.config.dataDir, task.id, Number(c.req.param('round')), c.req.param('name'));
    if (!file) throw new AppError('NOT_FOUND', 'design file not found', 404);
    c.header('Content-Type', DESIGN_FILE_TYPES[path.extname(file).toLowerCase()]!);
    c.header('X-Content-Type-Options', 'nosniff');
    // Agent-written pages run in an opaque origin even when opened on their own, so their scripts
    // can't call this API as the board.
    c.header('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-modals');
    c.header('Referrer-Policy', 'no-referrer');
    // Option URLs carry the file's mtime; files the pages load (no ?v=) must not go stale.
    c.header('Cache-Control', c.req.query('v') ? 'private, max-age=31536000, immutable' : 'no-cache');
    return c.body(fs.readFileSync(file));
  });
  app.get('/api/tasks/:id/screenshots/:name', (c) => {
    const task = getTaskOrThrow(ctx, c.req.param('id'));
    const file = screenshotPath(ctx.config.dataDir, task, c.req.param('name'));
    if (!file) throw new AppError('NOT_FOUND', 'screenshot not found', 404);
    c.header('Content-Type', SCREENSHOT_TYPES[path.extname(file).toLowerCase()]!);
    c.header('X-Content-Type-Options', 'nosniff');
    // The URL carries the file's mtime, so a replaced screenshot gets a new URL.
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    return c.body(fs.readFileSync(file));
  });
  app.patch('/api/tasks/:id', async (c) => {
    const row = patchTask(ctx, c.req.param('id'), await body(c, PatchTaskBody));
    return c.json(taskView(ctx.db, row.id, vc()));
  });
  app.post('/api/tasks/:id/actions/:action', async (c) => {
    const action = c.req.param('action') as TaskAction;
    if (!TASK_ACTIONS.includes(action)) throw new AppError('VALIDATION', `unknown action ${action}`, 404);
    const row = await runAction(ctx, c.req.param('id'), action, await body(c, TaskActionBody));
    return c.json({ ok: true, task: taskView(ctx.db, row.id, vc()) });
  });
  app.post('/api/tasks/:id/follow-ups', async (c) => {
    const { text } = await body(c, z.object({ text: z.string().trim().min(1) }));
    const row = createFollowUp(ctx, c.req.param('id'), text);
    return c.json(taskView(ctx.db, row.id, vc()), 201);
  });
  app.get('/api/tasks/:id/diff', async (c) => c.json(await engine.diff(c.req.param('id'), c.req.query('view') === 'full')));
  app.get('/api/tasks/:id/events', (c) => {
    const after = Number(c.req.query('after') ?? 0) || 0;
    const rows = ctx.db
      .select()
      .from(events)
      .where(and(eq(events.taskId, c.req.param('id')), gt(events.id, after)))
      .orderBy(asc(events.id))
      .limit(500)
      .all();
    return c.json(rows.map(eventView));
  });

  // ---- run project ---------------------------------------------------------------
  const runs = engine.projectRuns;
  const runOr404 = <T>(v: T | null): T => {
    if (v === null) throw new AppError('NOT_FOUND', 'run not found', 404);
    return v;
  };
  app.get('/api/project-runs', (c) => c.json(runs.list()));
  app.get('/api/project-runs/:id/log', (c) => c.json(runOr404(runs.log(c.req.param('id')))));
  app.post('/api/project-runs/:id/stop', async (c) => c.json(runOr404(await runs.stop(c.req.param('id')))));
  app.post('/api/project-runs/:id/fix', async (c) => {
    const { note } = await body(c, FixRunBody);
    const r = await fixProjectRun(ctx, runs, c.req.param('id'), note);
    return c.json({ run: r.run, task: taskView(ctx.db, r.task.id, vc())!, created: r.created, startError: r.startError });
  });
  app.get('/api/boards/:id/run', async (c) => c.json(await runInfo(ctx, runs, boardOr404(c.req.param('id')).id, null)));
  app.post('/api/boards/:id/run', async (c) => {
    const b = boardOr404(c.req.param('id'));
    return c.json(await startProjectRun(ctx, runs, b.id, null, await body(c, StartRunBody)));
  });
  app.get('/api/tasks/:id/run', async (c) => {
    const task = getTaskOrThrow(ctx, c.req.param('id'));
    return c.json(await runInfo(ctx, runs, task.boardId, task.id));
  });
  app.post('/api/tasks/:id/run', async (c) => {
    const task = getTaskOrThrow(ctx, c.req.param('id'));
    return c.json(await startProjectRun(ctx, runs, task.boardId, task.id, await body(c, StartRunBody)));
  });
  app.post('/api/boards/:id/open-in-vscode', async (c) => c.json(await openProjectInVsCode(ctx, boardOr404(c.req.param('id')).id, null)));
  app.post('/api/tasks/:id/open-in-vscode', async (c) => {
    const task = getTaskOrThrow(ctx, c.req.param('id'));
    return c.json(await openProjectInVsCode(ctx, task.boardId, task.id));
  });
  app.get('/api/boards/:id/github', async (c) => c.json(await projectGithubUrl(ctx, boardOr404(c.req.param('id')).id)));

  // ---- stream ----------------------------------------------------------------
  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const queue: Array<{ event: string; data: string }> = [];
      let wake: (() => void) | null = null;
      const unsubscribe = ctx.bus.subscribe((m) => {
        queue.push({ event: m.event, data: JSON.stringify(m.data) });
        wake?.();
      });
      const heartbeat = setInterval(() => {
        queue.push({ event: 'ping', data: '{}' });
        wake?.();
      }, 15_000);
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: 'health', data: JSON.stringify(ctx.health.get()) });
      while (!stream.aborted) {
        while (queue.length) {
          const m = queue.shift()!;
          if (m.event === 'ping') await stream.write(': ping\n\n');
          else await stream.writeSSE(m);
        }
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
      clearInterval(heartbeat);
      unsubscribe();
    }),
  );

  // ---- MCP: agents in T3 Code asking what a board is doing (read-only) ------------
  app.post('/mcp', (c) => handleMcp(c, ctx));
  app.on(['GET', 'DELETE'], '/mcp', (c) => c.text('Method Not Allowed', 405, { Allow: 'POST' }));

  app.all('/api/*', (c) => c.json({ ok: false, error: { code: 'NOT_FOUND', message: `no route ${c.req.method} ${c.req.path}` } }, 404));

  // ---- web app (production) ----------------------------------------------------
  if (o.webDistDir && fs.existsSync(path.join(o.webDistDir, 'index.html'))) {
    const root = path.relative(process.cwd(), o.webDistDir) || '.';
    app.use('/assets/*', serveStatic({ root }));
    app.use('*', serveStatic({ root }));
    const indexHtml = fs.readFileSync(path.join(o.webDistDir, 'index.html'), 'utf8');
    app.get('*', (c) => c.html(indexHtml)); // SPA fallback
  } else {
    app.get('/', (c) => c.text('T3 Orchestra API is running. In development, open the Vite dev server (http://localhost:5173).'));
  }

  return app;
}
