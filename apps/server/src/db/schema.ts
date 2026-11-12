// SQLite schema (spec §10). Timestamps are ISO-8601 UTC strings.
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  AcceptInto,
  AnyIdeaCategory,
  Attention,
  Category,
  Complexity,
  DesignChoice,
  DesignOptionInfo,
  DesignRoundStatus,
  DiffStat,
  FindingStatus,
  IdeaBatchStatus,
  IdeaDifficulty,
  IdeaImpact,
  IdeaKind,
  IdeaStatus,
  InsightMessageStatus,
  KnowledgeBuildStats,
  KnowledgeBuildStatus,
  KnowledgeEdge,
  KnowledgeFileStatus,
  KnowledgeNode,
  InsightRole,
  MarketingSourceKind,
  MarketingSourceStatus,
  MergeStrategy,
  NotifyType,
  PlanAnswer,
  PlanOptions,
  PlanResult,
  PlanStatus,
  Priority,
  ProjectImportStatus,
  ReviewStrictness,
  RunConfig,
  RunKind,
  RunStatus,
  AuditCoverage,
  SecurityArea,
  SecurityAuditScope,
  SecurityAuditStatus,
  SecurityCategory,
  SecurityConfidence,
  SecurityDismissReason,
  SecurityFindingMeta,
  SecurityFindingStatus,
  SecurityResolvedBy,
  SecurityScanKind,
  SecurityScanStats,
  SecurityScanStatus,
  SecuritySeverity,
  SecuritySource,
  Severity,
  SpecQuestion,
  Stage,
  StageReason,
  ThreadRole,
} from '@t3-orchestra/shared';

const bool = (name: string) => integer(name, { mode: 'boolean' });

export interface RunLaunch {
  project: string;
  title: string;
  provider?: string | null;
  model?: string | null;
  worktree?: { baseRef: string; branch: string };
}

export const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  short: text('short').notNull().unique(),
  projectPath: text('project_path').notNull(),
  t3ProjectId: text('t3_project_id'),
  baseBranch: text('base_branch').notNull(),
  brief: text('brief').notNull().default(''),
  /** What the product is and who it's for, for the Marketing agent. */
  marketingBrief: text('marketing_brief').notNull().default(''),
  /** What security audits should know: who uses the app, what it protects, what is out of scope. */
  securityBrief: text('security_brief').notNull().default(''),
  /** AI reviews also check each task's change for security issues. */
  securityReview: bool('security_review').notNull().default(false),
  /** Re-run the secret and dependency scans when the checkout moves to a new commit (else daily). */
  securityAutoScan: bool('security_auto_scan').notNull().default(false),
  /** Read new context files into the knowledge graph as soon as they are added. */
  contextAutoBuild: bool('context_auto_build').notNull().default(true),
  /** Agent prompts include the knowledge graph's overview and the parts that match their work. */
  contextInPrompts: bool('context_in_prompts').notNull().default(true),
  autoRun: bool('auto_run').notNull().default(false),
  maxParallel: integer('max_parallel').notNull().default(3),
  acceptInto: text('accept_into').$type<AcceptInto>().notNull().default('ready'),
  aiReview: bool('ai_review').notNull().default(true),
  skipReviewForTrivial: bool('skip_review_for_trivial').notNull().default(true),
  maxFixRounds: integer('max_fix_rounds').notNull().default(2),
  reviewStrictness: text('review_strictness').$type<ReviewStrictness>().notNull().default('major'),
  avoidOverlap: bool('avoid_overlap').notNull().default(true),
  mergeStrategy: text('merge_strategy').$type<MergeStrategy>().notNull().default('local'),
  defaultProvider: text('default_provider'),
  defaultModel: text('default_model'),
  plannerModel: text('planner_model'),
  reviewerModel: text('reviewer_model'),
  /** Tasks the AI reviewer passes with a review score below this are approved without you; null = off. */
  autoApproveBelow: integer('auto_approve_below'),
  nextTaskNumber: integer('next_task_number').notNull().default(1),
  nextPlanNumber: integer('next_plan_number').notNull().default(1),
  nextMilestoneNumber: integer('next_milestone_number').notNull().default(1),
  observedRuntimeMode: text('observed_runtime_mode'),
  /** "Run project" command chosen by the user; null = detect it. */
  runConfig: text('run_config', { mode: 'json' }).$type<RunConfig>(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  archivedAt: text('archived_at'),
});

export const plans = sqliteTable(
  'plans',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    prompt: text('prompt').notNull(),
    options: text('options', { mode: 'json' }).$type<PlanOptions>().notNull(),
    status: text('status').$type<PlanStatus>().notNull(),
    attention: text('attention').$type<Attention>(),
    threadId: text('thread_id'),
    threadLink: text('thread_link'),
    currentVersion: integer('current_version').notNull().default(0),
    /** Whether the one automatic correction message has been sent for the current run. */
    correctionSent: bool('correction_sent').notNull().default(false),
    acceptedKeys: text('accepted_keys', { mode: 'json' }).$type<string[]>().notNull().default([]),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('plans_board_number').on(t.boardId, t.number)],
);

export const planVersions = sqliteTable(
  'plan_versions',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id),
    version: integer('version').notNull(),
    source: text('source').$type<'agent' | 'user'>().notNull().default('agent'),
    runId: text('run_id'),
    rawText: text('raw_text').notNull(),
    parsed: text('parsed', { mode: 'json' }).$type<PlanResult>(),
    validationErrors: text('validation_errors', { mode: 'json' }).$type<string[]>(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('plan_versions_plan_version').on(t.planId, t.version)],
);

/** Spec-first plans: one row per planner reply while it drafts the spec with the user. */
export const planSpecRounds = sqliteTable(
  'plan_spec_rounds',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id),
    round: integer('round').notNull(),
    runId: text('run_id'),
    /** The planner's spec (markdown); '' when the reply could not be used. */
    spec: text('spec').notNull().default(''),
    /** The user's edit of this round's spec. */
    userSpec: text('user_spec'),
    changes: text('changes').notNull().default(''),
    questions: text('questions', { mode: 'json' }).$type<SpecQuestion[]>().notNull().default([]),
    /** Set when the user sends the round back (answers, a note, or Generate tasks). */
    answers: text('answers', { mode: 'json' }).$type<PlanAnswer[]>(),
    feedback: text('feedback'),
    rawText: text('raw_text').notNull(),
    validationErrors: text('validation_errors', { mode: 'json' }).$type<string[]>(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('plan_spec_rounds_plan_round').on(t.planId, t.round)],
);

/** A phase of the board's work (M1, M2…) that tasks can belong to; ordered by `position`. */
export const milestones = sqliteTable(
  'milestones',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** What is true once the milestone is done (markdown). */
    goal: text('goal').notNull().default(''),
    position: real('position').notNull(),
    /** The plan whose acceptance created it, if any. */
    planId: text('plan_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('milestones_board_number').on(t.boardId, t.number)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    number: integer('number').notNull(),
    planId: text('plan_id'),
    planKey: text('plan_key'),
    /** Task whose implementer suggested this one ("Add as task"), and the suggestion as written. */
    followUpOf: text('follow_up_of'),
    followUpText: text('follow_up_text'),
    milestoneId: text('milestone_id'),
    /** Follow-up suggestions from this task's result that the user dismissed (exact text). */
    dismissedFollowUps: text('dismissed_follow_ups', { mode: 'json' }).$type<string[]>().notNull().default([]),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    acceptanceCriteria: text('acceptance_criteria', { mode: 'json' }).$type<string[]>().notNull().default([]),
    category: text('category').$type<Category>().notNull().default('feature'),
    complexity: text('complexity').$type<Complexity>().notNull().default('medium'),
    priority: text('priority').$type<Priority>().notNull().default('medium'),
    touches: text('touches', { mode: 'json' }).$type<string[]>().notNull().default([]),
    position: real('position').notNull(),
    stage: text('stage').$type<Stage>().notNull(),
    stageReason: text('stage_reason').$type<StageReason>(),
    attention: text('attention').$type<Attention>(),
    threadId: text('thread_id'),
    threadLink: text('thread_link'),
    branch: text('branch'),
    worktreePath: text('worktree_path'),
    /** Fresh-retry counter: branch suffix -r<attempt> when attempt > 1. */
    attempt: integer('attempt').notNull().default(1),
    fixRound: integer('fix_round').notNull().default(0),
    reviewRound: integer('review_round').notNull().default(0),
    /** The latest AI review's 1-10 score for how much the task needs a human look (null = none yet). */
    reviewScore: integer('review_score'),
    reviewScoreReason: text('review_score_reason'),
    skipAiReview: bool('skip_ai_review').notNull().default(false),
    /** "Run next": auto-run starts this Ready task before every other one (at most one per board). */
    runNext: bool('run_next').notNull().default(false),
    providerOverride: text('provider_override'),
    modelOverride: text('model_override'),
    lastResult: text('last_result', { mode: 'json' }),
    lastSummary: text('last_summary'),
    lastMessage: text('last_message'),
    resultMissing: bool('result_missing').notNull().default(false),
    prUrl: text('pr_url'),
    lastThreadStatus: text('last_thread_status'),
    lastItemCount: integer('last_item_count'),
    lastActivityAt: text('last_activity_at'),
    diffStat: text('diff_stat', { mode: 'json' }).$type<DiffStat>(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    activitySinceReview: bool('activity_since_review').notNull().default(false),
    /** Latest T3 run id seen on the task thread (detects runs started outside the app, §8). */
    lastT3RunId: text('last_t3_run_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('tasks_board_number').on(t.boardId, t.number), index('tasks_board_stage').on(t.boardId, t.stage)],
);

export const taskDeps = sqliteTable(
  'task_deps',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    dependsOnTaskId: text('depends_on_task_id')
      .notNull()
      .references(() => tasks.id),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] })],
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    taskId: text('task_id'),
    planId: text('plan_id'),
    kind: text('kind').$type<RunKind>().notNull(),
    threadId: text('thread_id'),
    threadLink: text('thread_link'),
    threadRole: text('thread_role').$type<ThreadRole>().notNull(),
    /** Title marker, used to find the thread again after a failed/timed-out start (§15.3). */
    marker: text('marker'),
    /** How to start the thread (new-thread runs only), so a `starting` run can be resumed after a crash. */
    launch: text('launch', { mode: 'json' }).$type<RunLaunch>(),
    round: integer('round'),
    baselineRunId: text('baseline_run_id'),
    t3RunId: text('t3_run_id'),
    /** True for runs T3 Orchestra did not start (the user chatted with the thread in T3). */
    external: bool('external').notNull().default(false),
    status: text('status').$type<RunStatus>().notNull(),
    startItemCount: integer('start_item_count'),
    promptText: text('prompt_text').notNull(),
    resultRaw: text('result_raw'),
    resultJson: text('result_json', { mode: 'json' }),
    error: text('error'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('runs_status').on(t.status), index('runs_thread').on(t.threadId)],
);

/** Insights chats: questions about the board's project, answered by a read-only agent in one T3 thread each. */
export const insightChats = sqliteTable(
  'insight_chats',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** Null until the first question's thread starts (and again if that thread is gone). */
    threadId: text('thread_id'),
    threadLink: text('thread_link'),
    /** The thread's latest T3 run when its last answer was filled in; later runs nobody here started are picked up. */
    lastT3RunId: text('last_t3_run_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('insight_chats_board_number').on(t.boardId, t.number)],
);

export const insightMessages = sqliteTable(
  'insight_messages',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => insightChats.id),
    boardId: text('board_id').notNull(),
    /** Order within the chat (a question and its answer are inserted together). */
    seq: integer('seq').notNull(),
    role: text('role').$type<InsightRole>().notNull(),
    text: text('text').notNull().default(''),
    /** Assistant only: the agent's earlier messages of the same turn, oldest first. */
    notes: text('notes', { mode: 'json' }).$type<string[]>().notNull().default([]),
    status: text('status').$type<InsightMessageStatus>().notNull(),
    /** The agent run that answers (assistant messages). */
    runId: text('run_id'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [uniqueIndex('insight_messages_chat_seq').on(t.chatId, t.seq), index('insight_messages_run').on(t.runId)],
);

/** Ideas generations: a read-only agent run that proposes ideas (or marketing tasks) of one category for the board's project. */
export const ideaBatches = sqliteTable(
  'idea_batches',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    number: integer('number').notNull(),
    category: text('category').$type<AnyIdeaCategory>().notNull(),
    status: text('status').$type<IdeaBatchStatus>().notNull(),
    threadId: text('thread_id'),
    threadLink: text('thread_link'),
    /** The run filling the generation in (the correction run after an unusable result). */
    runId: text('run_id'),
    /** Whether the one automatic correction message has been sent. */
    correctionSent: bool('correction_sent').notNull().default(false),
    summary: text('summary'),
    /** Marketing only: a brief the agent wrote because the board had none. */
    suggestedBrief: text('suggested_brief'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [uniqueIndex('idea_batches_board_number').on(t.boardId, t.number), index('idea_batches_run').on(t.runId)],
);

export const ideas = sqliteTable(
  'ideas',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id').notNull(),
    batchId: text('batch_id')
      .notNull()
      .references(() => ideaBatches.id),
    category: text('category').$type<AnyIdeaCategory>().notNull(),
    kind: text('kind').$type<IdeaKind>().notNull().default('build'),
    title: text('title').notNull(),
    description: text('description').notNull(),
    details: text('details').notNull().default(''),
    /** `do` tasks: copy ready to paste. */
    draft: text('draft').notNull().default(''),
    acceptanceCriteria: text('acceptance_criteria', { mode: 'json' }).$type<string[]>().notNull().default([]),
    touches: text('touches', { mode: 'json' }).$type<string[]>().notNull().default([]),
    impact: text('impact').$type<IdeaImpact>().notNull(),
    difficulty: text('difficulty').$type<IdeaDifficulty>().notNull(),
    status: text('status').$type<IdeaStatus>().notNull().default('new'),
    /** The task "Add to board" made from it. */
    taskId: text('task_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('ideas_board_status').on(t.boardId, t.status), index('ideas_batch').on(t.batchId)],
);

/**
 * Imports from T3 Code history: a read-only agent run over the project's T3 threads and its code
 * that writes the board's project context into the brief. The board shows the latest one.
 */
export const projectImports = sqliteTable(
  'project_imports',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    number: integer('number').notNull(),
    status: text('status').$type<ProjectImportStatus>().notNull(),
    /** The project's threads T3 Orchestra found, and how many of them it sent with their messages. */
    threadCount: integer('thread_count').notNull().default(0),
    threadsRead: integer('threads_read').notNull().default(0),
    threadId: text('thread_id'),
    threadLink: text('thread_link'),
    /** The run filling the import in (the correction run after an unusable result). */
    runId: text('run_id'),
    /** Whether the one automatic correction message has been sent. */
    correctionSent: bool('correction_sent').notNull().default(false),
    summary: text('summary'),
    nextSteps: text('next_steps', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** The markdown put into the board brief, so the next import can replace it there. */
    text: text('text'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [uniqueIndex('project_imports_board_number').on(t.boardId, t.number), index('project_imports_run').on(t.runId)],
);

/** Marketing metric sources: an API the server reads numbers from, or a metric typed in by hand. */
export const marketingSources = sqliteTable(
  'marketing_sources',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    kind: text('kind').$type<MarketingSourceKind>().notNull(),
    name: text('name').notNull(),
    /** The kind's fields, without the secret one. */
    config: text('config', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
    /** API key or token; never leaves the server. */
    secret: text('secret'),
    status: text('status').$type<MarketingSourceStatus>().notNull().default('new'),
    error: text('error'),
    lastFetchedAt: text('last_fetched_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('marketing_sources_board').on(t.boardId)],
);

/** One fetched (or logged) value of one metric. */
export const marketingSnapshots = sqliteTable(
  'marketing_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: text('source_id')
      .notNull()
      .references(() => marketingSources.id),
    metric: text('metric').notNull(),
    value: real('value').notNull(),
    takenAt: text('taken_at').notNull(),
  },
  (t) => [index('marketing_snapshots_source').on(t.sourceId, t.takenAt)],
);

export const reviewFindings = sqliteTable('review_findings', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  runId: text('run_id').notNull(),
  round: integer('round').notNull(),
  severity: text('severity').$type<Severity>().notNull(),
  file: text('file'),
  line: integer('line'),
  title: text('title').notNull(),
  detail: text('detail').notNull().default(''),
  suggestion: text('suggestion'),
  status: text('status').$type<FindingStatus>().notNull().default('open'),
});

/**
 * Rounds of HTML design options an implementer made for the user to pick from before building.
 * The files live in <dataDir>/designs/<taskId>/<round>, outside the repo; rounds survive Retry fresh.
 */
export const designRounds = sqliteTable(
  'design_rounds',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    /** 1, 2, … per task. */
    round: integer('round').notNull(),
    /** The run that made the options. */
    runId: text('run_id'),
    status: text('status').$type<DesignRoundStatus>().notNull().default('open'),
    question: text('question'),
    summary: text('summary'),
    /** The round's pages in order, with the agent's titles and summaries. */
    options: text('options', { mode: 'json' }).$type<DesignOptionInfo[]>().notNull().default([]),
    /** What the user decided (set once the round is no longer open). */
    choice: text('choice', { mode: 'json' }).$type<DesignChoice>(),
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at'),
  },
  (t) => [uniqueIndex('design_rounds_task_round').on(t.taskId, t.round)],
);

/** Security audits: a read-only agent run over the project (or its recent changes) that reports findings. */
export const securityAudits = sqliteTable(
  'security_audits',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    number: integer('number').notNull(),
    scope: text('scope').$type<SecurityAuditScope>().notNull(),
    /** Empty: every area. */
    focus: text('focus', { mode: 'json' }).$type<SecurityArea[]>().notNull().default([]),
    paths: text('paths', { mode: 'json' }).$type<string[]>().notNull().default([]),
    instructions: text('instructions').notNull().default(''),
    /** `changes` audits: the commit the audit before read. */
    baseSha: text('base_sha'),
    /** The commit of the root checkout when the audit started. */
    headSha: text('head_sha'),
    status: text('status').$type<SecurityAuditStatus>().notNull(),
    threadId: text('thread_id'),
    threadLink: text('thread_link'),
    /** The run filling the audit in (the correction run after an unusable result). */
    runId: text('run_id'),
    /** Whether the one automatic correction message has been sent. */
    correctionSent: bool('correction_sent').notNull().default(false),
    summary: text('summary'),
    attackSurface: text('attack_surface'),
    coverage: text('coverage', { mode: 'json' }).$type<AuditCoverage[]>().notNull().default([]),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [uniqueIndex('security_audits_board_number').on(t.boardId, t.number), index('security_audits_run').on(t.runId)],
);

/** Runs of the secret scan and the dependency scan (both run in the server, no agent). */
export const securityScans = sqliteTable(
  'security_scans',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    kind: text('kind').$type<SecurityScanKind>().notNull(),
    status: text('status').$type<SecurityScanStatus>().notNull(),
    headSha: text('head_sha'),
    stats: text('stats', { mode: 'json' }).$type<SecurityScanStats>().notNull().default({}),
    newCount: integer('new_count').notNull().default(0),
    fixedCount: integer('fixed_count').notNull().default(0),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('security_scans_board').on(t.boardId, t.kind, t.createdAt)],
);

/**
 * Security findings from audits and scans, numbered per board (S-1, S-2…). A later audit or scan
 * that reports the same problem (same fingerprint) updates it rather than adding another.
 */
export const securityFindings = sqliteTable(
  'security_findings',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    number: integer('number').notNull(),
    source: text('source').$type<SecuritySource>().notNull(),
    fingerprint: text('fingerprint').notNull(),
    /** The audit that first reported it. */
    auditId: text('audit_id'),
    /** The scan that last saw it. */
    scanId: text('scan_id'),
    severity: text('severity').$type<SecuritySeverity>().notNull(),
    category: text('category').$type<SecurityCategory>().notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    details: text('details').notNull().default(''),
    recommendation: text('recommendation').notNull().default(''),
    file: text('file'),
    line: integer('line'),
    cwe: text('cwe'),
    confidence: text('confidence').$type<SecurityConfidence>().notNull().default('medium'),
    acceptanceCriteria: text('acceptance_criteria', { mode: 'json' }).$type<string[]>().notNull().default([]),
    touches: text('touches', { mode: 'json' }).$type<string[]>().notNull().default([]),
    meta: text('meta', { mode: 'json' }).$type<SecurityFindingMeta>().notNull(),
    status: text('status').$type<SecurityFindingStatus>().notNull().default('open'),
    dismissReason: text('dismiss_reason').$type<SecurityDismissReason>(),
    dismissNote: text('dismiss_note').notNull().default(''),
    /** The task "Add to board" made. */
    taskId: text('task_id'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    resolvedAt: text('resolved_at'),
    resolvedBy: text('resolved_by').$type<SecurityResolvedBy>(),
    /** The audit that found it fixed. */
    resolvedAuditId: text('resolved_audit_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('security_findings_board_number').on(t.boardId, t.number),
    uniqueIndex('security_findings_board_fingerprint').on(t.boardId, t.fingerprint),
    index('security_findings_board_status').on(t.boardId, t.status),
  ],
);

/** Files the user added on the Context page. They live in <dataDir>/context/<boardId>/, outside the repo. */
export const contextFiles = sqliteTable(
  'context_files',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    name: text('name').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').$type<KnowledgeFileStatus>().notNull(),
    /** The agent's one-line account of the file. */
    summary: text('summary'),
    /** Why the agent skipped it. */
    note: text('note'),
    /** What the user says the file is and what matters in it. */
    description: text('description'),
    uploadedAt: text('uploaded_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('context_files_board_name').on(t.boardId, t.name)],
);

/** Runs of the agent that reads context files into the board's knowledge graph. */
export const contextBuilds = sqliteTable(
  'context_builds',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    number: integer('number').notNull(),
    status: text('status').$type<KnowledgeBuildStatus>().notNull(),
    /** Started over: the result replaces the graph instead of adding to it. */
    fresh: bool('fresh').notNull().default(false),
    /** The files it reads, with the content and description it was given (a file changed since stays pending). */
    files: text('files', { mode: 'json' })
      .$type<Array<{ id: string; name: string; sha256: string; description?: string | null }>>()
      .notNull()
      .default([]),
    threadId: text('thread_id'),
    threadLink: text('thread_link'),
    /** The run filling the build in (the correction run after an unusable result). */
    runId: text('run_id'),
    /** Whether the one automatic correction message has been sent. */
    correctionSent: bool('correction_sent').notNull().default(false),
    summary: text('summary'),
    stats: text('stats', { mode: 'json' }).$type<KnowledgeBuildStats>(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [uniqueIndex('context_builds_board_number').on(t.boardId, t.number), index('context_builds_run').on(t.runId)],
);

/** One knowledge graph per board, kept whole: nodes and edges as JSON. */
export const contextGraphs = sqliteTable('context_graphs', {
  boardId: text('board_id')
    .primaryKey()
    .references(() => boards.id),
  nodes: text('nodes', { mode: 'json' }).$type<KnowledgeNode[]>().notNull().default([]),
  edges: text('edges', { mode: 'json' }).$type<KnowledgeEdge[]>().notNull().default([]),
  /** Markdown overview every agent prompt starts from. */
  digest: text('digest').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
});

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    boardId: text('board_id').notNull(),
    taskId: text('task_id'),
    planId: text('plan_id'),
    runId: text('run_id'),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('events_task').on(t.taskId, t.id)],
);

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  boardId: text('board_id').notNull(),
  taskId: text('task_id'),
  planId: text('plan_id'),
  type: text('type').$type<NotifyType>().notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull(),
  readAt: text('read_at'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});

export type BoardRow = typeof boards.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type MilestoneRow = typeof milestones.$inferSelect;
export type PlanVersionRow = typeof planVersions.$inferSelect;
export type PlanSpecRoundRow = typeof planSpecRounds.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type FindingRow = typeof reviewFindings.$inferSelect;
export type DesignRoundRow = typeof designRounds.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type InsightChatRow = typeof insightChats.$inferSelect;
export type InsightMessageRow = typeof insightMessages.$inferSelect;
export type IdeaBatchRow = typeof ideaBatches.$inferSelect;
export type IdeaRow = typeof ideas.$inferSelect;
export type MarketingSourceRow = typeof marketingSources.$inferSelect;
export type ProjectImportRow = typeof projectImports.$inferSelect;
export type SecurityAuditRow = typeof securityAudits.$inferSelect;
export type SecurityScanRow = typeof securityScans.$inferSelect;
export type SecurityFindingRow = typeof securityFindings.$inferSelect;
export type ContextFileRow = typeof contextFiles.$inferSelect;
export type ContextBuildRow = typeof contextBuilds.$inferSelect;
export type ContextGraphRow = typeof contextGraphs.$inferSelect;
