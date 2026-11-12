// View models returned by the REST API and pushed over SSE (spec §11.3, §11.4).
import type {
  AcceptInto,
  AnyIdeaCategory,
  Attention,
  Category,
  Column,
  Complexity,
  DesignRoundStatus,
  ErrorCode,
  FindingStatus,
  IdeaBatchStatus,
  IdeaDifficulty,
  IdeaImpact,
  IdeaKind,
  IdeaStatus,
  InsightMessageStatus,
  InsightRole,
  MergeStrategy,
  NotifyType,
  PlanStatus,
  Priority,
  ProjectImportStatus,
  ReviewStrictness,
  RunKind,
  RunStatus,
  Severity,
  Stage,
  StageReason,
  ThreadRole,
} from './enums.ts';
import type { AppSettings, DesignChoice, ImplementResult, PlanAnswer, PlanResult, PlanTask, SpecQuestion } from './contracts.ts';
import type { MarketingSourceView } from './marketing.ts';
import type { ProjectRunView, RunConfig } from './projectRun.ts';
import type { KnowledgeBuildView } from './knowledge.ts';
import type { SecurityAuditView, SecurityFindingView, SecurityOpenCounts, SecurityScanView } from './security.ts';

export interface HealthView {
  cliFound: boolean;
  serverReachable: boolean;
  version?: string;
  error?: string;
  fake?: boolean;
  checkedAt: string;
}

/** A model a T3 provider offers (from T3's server config). */
export interface T3ModelView {
  slug: string;
  name: string;
  /** The provider's own default model. */
  isDefault: boolean;
  /** Hidden in T3's model pickers by the user. */
  hidden: boolean;
}

export interface T3ProviderView {
  /** Provider instance id, what `--provider` takes. */
  id: string;
  name: string;
  /** T3's provider status, e.g. "ready". */
  status: string;
  models: T3ModelView[];
}

/** GET /api/t3/models: the providers enabled in T3 Code and their models, in T3's order. */
export interface T3ModelCatalogView {
  /** T3's default provider (its default model selection); null when T3 names none. */
  defaultProvider: string | null;
  providers: T3ProviderView[];
}

/** GET /api/t3/projects: a project T3 Code knows, for "Import from T3 Code" in the New board dialog. */
export interface T3ProjectView {
  id: string;
  title: string;
  path: string;
  /** Top-level threads (not sub-agents). */
  threadCount: number;
  lastActivityAt: string | null;
  /** The board that already points at this project, if any. */
  boardSlug: string | null;
}

/** The board's latest import: an agent read the project's T3 threads and code and wrote the project context. */
export interface ProjectImportView {
  id: string;
  number: number;
  status: ProjectImportStatus;
  /** The project's threads in T3 (top-level, not counting T3 Orchestra's own review and import threads). */
  threadCount: number;
  /** Threads whose messages the agent got (the rest only by title). */
  threadsRead: number;
  threadLink: string | null;
  /** The agent's one-line take on the project. */
  summary: string | null;
  nextSteps: string[];
  /** The markdown it put into the board brief. */
  text: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface BoardCounts {
  total: number;
  active: number; // implementing + ai_review
  needsYou: number; // attention + human_review
  byColumn: Partial<Record<Column, number>>;
}

export interface BoardView {
  id: string;
  name: string;
  slug: string;
  short: string;
  projectPath: string;
  t3ProjectId: string | null;
  baseBranch: string;
  brief: string;
  /** What the product is and who it's for, as the Marketing agent should know it. */
  marketingBrief: string;
  /** What security audits should know: who uses the app, what it protects, what is out of scope. */
  securityBrief: string;
  /** AI reviews also check each task's change for security issues. */
  securityReview: boolean;
  /** The secret and dependency scans run again when the code changes. */
  securityAutoScan: boolean;
  /** Open security findings by severity (the Security tab's badge). */
  securityOpen: SecurityOpenCounts;
  /** Read new context files into the knowledge graph as soon as they are added. */
  contextAutoBuild: boolean;
  /** Agent prompts include the knowledge graph's overview and the parts that match their work. */
  contextInPrompts: boolean;
  autoRun: boolean;
  maxParallel: number;
  acceptInto: AcceptInto;
  aiReview: boolean;
  skipReviewForTrivial: boolean;
  maxFixRounds: number;
  reviewStrictness: ReviewStrictness;
  avoidOverlap: boolean;
  mergeStrategy: MergeStrategy;
  defaultProvider: string | null;
  defaultModel: string | null;
  plannerModel: string | null;
  reviewerModel: string | null;
  autoApproveBelow: number | null;
  nextTaskNumber: number;
  /** Runtime mode observed on the board's last T3 thread (e.g. "full-access"), shown in settings (§16). */
  observedRuntimeMode: string | null;
  /** The board's own "Run project" command; null = detect. */
  runConfig: RunConfig | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  counts: BoardCounts;
  /** The latest import from T3 Code history; null when the board never had one. */
  projectImport: ProjectImportView | null;
}

export interface TaskDepView {
  id: string;
  number: number;
  title: string;
  stage: Stage;
}

export interface DiffStat {
  added: number;
  removed: number;
  files: number;
}

export interface ActiveRunView {
  id: string;
  kind: RunKind;
  round: number | null;
  status: RunStatus;
  threadId: string | null;
  threadLink: string | null;
  startedAt: string;
  /** itemCount growth since the run began (activity signal). */
  events: number;
  /**
   * Background work the agent's ended turn waits on (e.g. "Run the full integration suite"); T3
   * resumes the agent when it is done. Empty while the agent works or when it waits on nothing.
   */
  background: string[];
}

export interface FindingCounts {
  open: Partial<Record<Severity, number>>;
  total: number;
}

/** The task's latest round of design options, for the card. */
export interface DesignSummaryView {
  round: number;
  status: DesignRoundStatus;
  options: number;
}

export interface TaskView {
  id: string;
  boardId: string;
  number: number;
  planId: string | null;
  planKey: string | null;
  /** Task whose suggested follow-up this was ("Add as task"), and the suggestion text. */
  followUpOf: string | null;
  followUpText: string | null;
  milestoneId: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  category: Category;
  complexity: Complexity;
  priority: Priority;
  touches: string[];
  position: number;
  stage: Stage;
  stageReason: StageReason | null;
  attention: Attention | null;
  column: Column;
  threadId: string | null;
  threadLink: string | null;
  branch: string | null;
  worktreePath: string | null;
  fixRound: number;
  reviewRound: number;
  /** Latest AI review's 1-10 score for how much this needs a human look; null until a review gives one. */
  reviewScore: number | null;
  reviewScoreReason: string | null;
  skipAiReview: boolean;
  /** "Run next": auto-run starts this Ready task before the others, overlap or not. */
  runNext: boolean;
  providerOverride: string | null;
  modelOverride: string | null;
  lastSummary: string | null;
  lastMessage: string | null;
  resultMissing: boolean;
  prUrl: string | null;
  lastThreadStatus: string | null;
  lastActivityAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  activitySinceReview: boolean;
  deps: TaskDepView[];
  /** Dependencies that are failed or discarded. */
  blockedBy: TaskDepView[];
  /** Dependencies that are not done yet (includes blockedBy). */
  waitingOn: TaskDepView[];
  activeRun: ActiveRunView | null;
  findings: FindingCounts;
  /** Latest round of HTML design options, if the agent ever made any. */
  design: DesignSummaryView | null;
  diffStat: DiffStat | null;
  /** Active run whose thread has been quiet longer than staleAfterMinutes (minutes), else null. */
  quietMinutes: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MilestoneView {
  id: string;
  boardId: string;
  number: number;
  title: string;
  /** What is true once the milestone is done (markdown). */
  goal: string;
  position: number;
  planId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An agent's follow-up suggestion that is neither added as a task nor dismissed. */
export interface SuggestionView {
  taskId: string;
  taskNumber: number;
  taskTitle: string;
  taskStage: Stage;
  /** The suggesting task's milestone. */
  milestoneId: string | null;
  text: string;
}

/** An Insights chat: questions about the board's project, answered by a read-only agent in one T3 thread. */
export interface InsightChatView {
  id: string;
  boardId: string;
  number: number;
  title: string;
  /** Status of the latest answer ('idle' before the first question). */
  status: InsightMessageStatus | 'idle';
  threadLink: string | null;
  messageCount: number;
  /** First line of the latest message, for the chat list. */
  preview: string;
  createdAt: string;
  updatedAt: string;
}

export interface InsightMessageView {
  id: string;
  chatId: string;
  boardId: string;
  seq: number;
  role: InsightRole;
  /** The question as typed, or the agent's final message. */
  text: string;
  /** Assistant only: the agent's earlier messages of the same turn ("Let me look at…"), oldest first. */
  notes: string[];
  status: InsightMessageStatus;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface InsightChatDetailView extends InsightChatView {
  messages: InsightMessageView[];
}

/** One run of the Ideas (or Marketing) agent over one category. */
export interface IdeaBatchView {
  id: string;
  boardId: string;
  number: number;
  category: AnyIdeaCategory;
  status: IdeaBatchStatus;
  threadLink: string | null;
  /** The agent's note on what it looked at (and why there are no ideas, when there are none). */
  summary: string | null;
  /** Marketing only: a brief the agent wrote because the board had none. */
  suggestedBrief: string | null;
  ideaCount: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface IdeaView {
  id: string;
  boardId: string;
  batchId: string;
  category: AnyIdeaCategory;
  /** Always `build` for code ideas. */
  kind: IdeaKind;
  title: string;
  description: string;
  details: string;
  /** `do` tasks: copy ready to paste (a post, an email); empty when there's nothing to write. */
  draft: string;
  acceptanceCriteria: string[];
  touches: string[];
  impact: IdeaImpact;
  difficulty: IdeaDifficulty;
  status: IdeaStatus;
  /** The task it became (status `added`). */
  taskId: string | null;
  taskNumber: number | null;
  createdAt: string;
}

/** GET /api/boards/:id/ideas: the generations (newest first) and the ideas that aren't dismissed. */
export interface BoardIdeasView {
  batches: IdeaBatchView[];
  ideas: IdeaView[];
}

export interface RunView {
  id: string;
  kind: RunKind;
  threadId: string | null;
  threadLink: string | null;
  threadRole: ThreadRole;
  round: number | null;
  status: RunStatus;
  promptText: string;
  resultRaw: string | null;
  resultJson: unknown;
  /** Agent summary from the result block, when there is one. */
  summary: string | null;
  error: string | null;
  external: boolean;
  startedAt: string;
  finishedAt: string | null;
}

export interface FindingView {
  id: string;
  taskId: string;
  runId: string;
  round: number;
  severity: Severity;
  file: string | null;
  line: number | null;
  title: string;
  detail: string;
  suggestion: string | null;
  status: FindingStatus;
}

export interface EventView {
  id: number;
  boardId: string;
  taskId: string | null;
  planId: string | null;
  runId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** An image the implementer saved in the task's screenshot folder. */
export interface ScreenshotView {
  name: string;
  /** API path that serves the file; changes when the file is replaced. */
  url: string;
}

/** One HTML mock-up of a round. */
export interface DesignOptionView {
  round: number;
  file: string;
  /** "A", "B", … in the round's order. */
  letter: string;
  title: string;
  summary: string;
  /** API path that serves the page; changes when the file is replaced. */
  url: string;
}

/** A round of design options and what the user decided. */
export interface DesignRoundView {
  id: string;
  round: number;
  status: DesignRoundStatus;
  /** The task is waiting for the user to pick from this round right now. */
  awaiting: boolean;
  question: string | null;
  summary: string | null;
  options: DesignOptionView[];
  choice: DesignChoice | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface TaskDetailView extends TaskView {
  lastResult: ImplementResult | null;
  /** Screenshots of the current attempt, oldest first. */
  screenshots: ScreenshotView[];
  /** Every round of design options, oldest first (rounds survive Retry fresh). */
  designRounds: DesignRoundView[];
  runs: RunView[];
  findingsList: FindingView[];
  events: EventView[];
}

export interface PlanVersionView {
  id: string;
  version: number;
  source: 'agent' | 'user';
  runId: string | null;
  rawText: string;
  parsed: PlanResult | null;
  validationErrors: string[] | null;
  createdAt: string;
}

export interface PlanView {
  id: string;
  boardId: string;
  number: number;
  title: string;
  prompt: string;
  options: {
    plannerModel?: string | null;
    maxTasks: number;
    askQuestions: boolean;
    extraGuidance: string;
    /** Missing on plans made before spec-first existed. */
    specFirst?: boolean;
  };
  status: PlanStatus;
  threadId: string | null;
  threadLink: string | null;
  currentVersion: number;
  error: string | null;
  attention: Attention | null;
  acceptedKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanDetailView extends PlanView {
  versions: PlanVersionView[];
  /** Proposed tasks of the current version (empty until the first valid version). */
  proposals: PlanTask[];
  /** Keys whose content changed relative to the previous version. */
  changedKeys: string[];
  /** Keys added since the previous version. */
  addedKeys: string[];
  /** Spec-first plans: every spec round, oldest first (unusable replies included, with their errors). */
  specRounds: SpecRoundView[];
  /** The current spec (the user's edit of the latest usable round, or the planner's), null without one. */
  spec: string | null;
  runs: RunView[];
}

/** One reply of the planner while it drafted the spec, and what the user sent back. */
export interface SpecRoundView {
  id: string;
  round: number;
  runId: string | null;
  /** The planner's spec ('' when the reply could not be used). */
  spec: string;
  /** The user's edit of this round's spec, if any. */
  userSpec: string | null;
  changes: string;
  questions: SpecQuestion[];
  /** What the user answered when they sent this round back (null: not sent yet). */
  answers: PlanAnswer[] | null;
  feedback: string | null;
  rawText: string;
  validationErrors: string[] | null;
  createdAt: string;
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface DiffView {
  base: string;
  head: string | null;
  branch: string | null;
  behindBy: number;
  uncommitted: string[];
  files: DiffFile[];
  patch?: string;
  /** The patch was cut at the server's size cap (see `files` for the full list). */
  truncated?: boolean;
}

/** POST /api/validate-project and /api/add-to-t3. */
export interface ProjectValidation {
  ok: boolean;
  /** The path is an existing folder (git or not). */
  exists: boolean;
  toplevel: string | null;
  /** The `origin` remote's URL, when the repository has one. */
  originUrl: string | null;
  /** A folder that isn't a repository yet: the files a first commit would take, counted up to a cap (`more`: past it). */
  folderFiles: { count: number; more: boolean } | null;
  /** Why git must not be set up in this folder (a drive root, the home folder, Documents…). */
  setupBlocked: string | null;
  currentBranch: string | null;
  branches: string[];
  baseBranch: string | null;
  baseBranchExists: boolean;
  isGitRepo: boolean;
  t3Known: boolean;
  t3Error: string | null;
  /** How many threads T3 has for the project (when it knows it). */
  t3ThreadCount: number | null;
  errors: string[];
}

/** GET /api/settings/info. */
export interface SettingsInfo {
  dataDir: string;
  port: number;
  publicUrl: string;
  fake: boolean;
  launcher: { kind: string; command: string; cliPath: string } | null;
  promptsDir: string;
  overriddenPrompts: string[];
  templates: string[];
}

export interface NotifyView {
  id: string;
  type: NotifyType;
  title: string;
  body: string;
  boardId: string;
  boardSlug?: string;
  taskId?: string | null;
  taskNumber?: number | null;
  planId?: string | null;
  createdAt: string;
}

export interface RunKindStats {
  kind: RunKind;
  runs: number;
  /** Runs that failed, were interrupted or cancelled, or got lost. */
  failed: number;
  /** Agent time of the finished runs. */
  totalMs: number;
  medianMs: number | null;
}

/** Spans of time spent waiting for the user; `open` are waits still going on. */
export interface WaitStats {
  count: number;
  totalMs: number;
  medianMs: number | null;
  open: number;
}

/** GET /api/boards/:id/stats: the Overview's numbers that need runs and events. */
export interface BoardStatsView {
  /** Run kinds with at least one run, in RUN_KINDS order. */
  runs: RunKindStats[];
  /** Agents waiting for your answer (Needs Input). */
  answerWait: WaitStats;
  /** Tasks waiting in Human Review until you (not auto-approve) moved them on. */
  reviewWait: WaitStats;
  /** Approvals (yours or auto-approve) that hit a merge conflict. */
  mergeConflicts: number;
}

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export type ActionResponse = { ok: true; task: TaskView } | { ok: false; error: ApiError };

/** Shape of every SSE message, keyed by `event:` name. */
export interface StreamEvents {
  task: TaskView;
  plan: PlanView;
  board: BoardView;
  health: HealthView;
  notify: NotifyView;
  task_removed: { id: string; boardId: string };
  milestone: MilestoneView;
  milestone_removed: { id: string; boardId: string };
  settings: AppSettings;
  project_run: ProjectRunView;
  /** New output of a project run; `start` is its offset in the run's whole output. */
  project_run_log: { id: string; start: number; text: string };
  insight_chat: InsightChatView;
  insight_chat_removed: { id: string; boardId: string };
  insight_message: InsightMessageView;
  idea_batch: IdeaBatchView;
  idea: IdeaView;
  marketing_source: MarketingSourceView;
  marketing_source_removed: { id: string; boardId: string };
  security_audit: SecurityAuditView;
  security_scan: SecurityScanView;
  security_finding: SecurityFindingView;
  knowledge_build: KnowledgeBuildView;
  /** The board's context files or knowledge graph changed: refetch them. */
  knowledge_changed: { boardId: string };
}
