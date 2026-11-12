// Enumerations shared by the server and the web UI (spec §6, §10).

export const STAGES = [
  'backlog',
  'ready',
  'implementing',
  'ai_review',
  'human_review',
  'done',
  'failed',
  'discarded',
] as const;
export type Stage = (typeof STAGES)[number];

export const HUMAN_REVIEW_REASONS = [
  'ai_passed',
  'ai_unresolved',
  'review_failed',
  'ai_review_skipped',
  'merge_conflict',
  'pr_opened',
  /** The agent made HTML design options and waits for the user to pick before it builds. */
  'design_options',
] as const;
export const FAILED_REASONS = [
  'run_failed',
  'run_interrupted',
  'run_cancelled',
  'agent_blocked',
  'thread_missing',
  'start_failed',
] as const;
export const DONE_REASONS = ['auto_approved'] as const;
export type StageReason =
  | (typeof HUMAN_REVIEW_REASONS)[number]
  | (typeof FAILED_REASONS)[number]
  | (typeof DONE_REASONS)[number];

export const ATTENTIONS = ['question', 'approval', 'waiting'] as const;
export type Attention = (typeof ATTENTIONS)[number];

export const COLUMNS = [
  'backlog',
  'ready',
  'running',
  'needs_input',
  'ai_review',
  'human_review',
  'done',
  'failed',
] as const;
export type Column = (typeof COLUMNS)[number] | 'hidden';

export const RUN_KINDS = [
  /** Before planning: the planner drafts a spec with the user and asks its questions. */
  'spec',
  'plan',
  'implement',
  'fix',
  'changes',
  'resume',
  'rebase',
  'followup',
  'pr',
  /** After a design pick: build the chosen design. */
  'design',
  /** After a design pick: make another round of options. */
  'options',
  'review',
  'insight',
  'ideas',
  /** Reading a project's T3 threads and code to write the board's project context. */
  'import',
  /** A security audit of the project (Security view). */
  'security',
  /** Reading the board's context files into its knowledge graph (Context view). */
  'knowledge',
] as const;
export type RunKind = (typeof RUN_KINDS)[number];
/** Run kinds that execute on the task thread (everything but spec, plan, review, insight, ideas, import, security and knowledge). */
export type TaskRunKind = Exclude<RunKind, 'spec' | 'plan' | 'review' | 'insight' | 'ideas' | 'import' | 'security' | 'knowledge'>;

export const RUN_STATUSES = [
  'starting',
  'active',
  'waiting',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'lost',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const OPEN_RUN_STATUSES: readonly RunStatus[] = ['starting', 'active', 'waiting'];

export type ThreadRole = 'task' | 'review' | 'plan' | 'insight' | 'ideas' | 'import' | 'security' | 'knowledge';

/**
 * Learning about a project from its T3 history: `gathering` while T3 Orchestra collects the threads,
 * `running` while the agent reads them and the code, `waiting` when it asks for something in T3.
 */
export const PROJECT_IMPORT_STATUSES = ['gathering', 'running', 'waiting', 'done', 'failed'] as const;
export type ProjectImportStatus = (typeof PROJECT_IMPORT_STATUSES)[number];

/** Insights chat messages: `pending` while the agent answers, `waiting` when it asks for something in T3. */
export const INSIGHT_MESSAGE_STATUSES = ['pending', 'waiting', 'done', 'failed'] as const;
export type InsightMessageStatus = (typeof INSIGHT_MESSAGE_STATUSES)[number];
export type InsightRole = 'user' | 'assistant';

/** A round of design options: `open` until the user picks, then `chosen` (build it) or `more` (another round). */
export const DESIGN_ROUND_STATUSES = ['open', 'chosen', 'more'] as const;
export type DesignRoundStatus = (typeof DESIGN_ROUND_STATUSES)[number];
export const DESIGN_CHOICE_MODES = ['build', 'more'] as const;
export type DesignChoiceMode = (typeof DESIGN_CHOICE_MODES)[number];

/** What an Ideas generation looks for; one category per generation. */
export const IDEA_CATEGORIES = ['code_improvements', 'ui_ux', 'documentation', 'security', 'performance', 'code_quality'] as const;
export type IdeaCategory = (typeof IDEA_CATEGORIES)[number];
/** Marketing tasks are ideas too, generated in the Marketing view with these categories. */
export const MARKETING_CATEGORIES = ['launch', 'content', 'seo', 'social', 'growth', 'analytics'] as const;
export type MarketingCategory = (typeof MARKETING_CATEGORIES)[number];
export const ALL_IDEA_CATEGORIES = [...IDEA_CATEGORIES, ...MARKETING_CATEGORIES] as const;
export type AnyIdeaCategory = IdeaCategory | MarketingCategory;
export const IDEA_CATEGORY_LABELS: Record<AnyIdeaCategory, string> = {
  code_improvements: 'Code improvements',
  ui_ux: 'UI/UX improvements',
  documentation: 'Documentation',
  security: 'Security',
  performance: 'Performance',
  code_quality: 'Code quality',
  launch: 'Launch & announcements',
  content: 'Content',
  seo: 'SEO & website',
  social: 'Social & community',
  growth: 'Growth & conversion',
  analytics: 'Analytics & tracking',
};
export function isMarketingCategory(c: string | null | undefined): c is MarketingCategory {
  return (MARKETING_CATEGORIES as readonly string[]).includes(c ?? '');
}
/** `build`: a change to the code (it goes on the board); `do`: something the team does outside the code (marketing only). */
export const IDEA_KINDS = ['build', 'do'] as const;
export type IdeaKind = (typeof IDEA_KINDS)[number];
/** An idea generation: `generating` while the agent works, `waiting` when it asks for something in T3. */
export const IDEA_BATCH_STATUSES = ['generating', 'waiting', 'done', 'failed'] as const;
export type IdeaBatchStatus = (typeof IDEA_BATCH_STATUSES)[number];
/** `added`: it became a task on the board; `done`: a `do` task the user marked done. */
export const IDEA_STATUSES = ['new', 'added', 'done', 'dismissed'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export const IDEA_IMPACTS = ['high', 'medium', 'low'] as const;
export type IdeaImpact = (typeof IDEA_IMPACTS)[number];
export const IDEA_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type IdeaDifficulty = (typeof IDEA_DIFFICULTIES)[number];

export const COMPLEXITIES = ['trivial', 'small', 'medium', 'large'] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const CATEGORIES = ['feature', 'bug', 'refactor', 'test', 'docs', 'infra', 'design'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export type Severity = (typeof SEVERITIES)[number];
/** Lower is more severe. */
export const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

export const REVIEW_STRICTNESS = ['blocker', 'major', 'minor'] as const;
export type ReviewStrictness = (typeof REVIEW_STRICTNESS)[number];

export const MERGE_STRATEGIES = ['local', 'pr', 'manual'] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

export const ACCEPT_INTO = ['ready', 'backlog'] as const;
export type AcceptInto = (typeof ACCEPT_INTO)[number];

export const PLAN_STATUSES = [
  /** Spec-first plans: the planner is drafting or updating the spec. */
  'speccing',
  /** Spec-first plans: the spec and the planner's questions wait for the user. */
  'spec_review',
  'planning',
  'needs_input',
  'ready',
  'refining',
  'accepted',
  'discarded',
  'failed',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const FINDING_STATUSES = ['open', 'addressed', 'dismissed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** T3 thread statuses (spec §4.4). */
export const THREAD_STATUSES = [
  'idle',
  'preparing',
  'queued',
  'starting',
  'running',
  'waiting',
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const NOTIFY_TYPES = [
  'task_attention',
  'plan_input',
  'plan_ready',
  'human_review',
  'task_failed',
  'board_done',
  't3_down',
] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];

export const TASK_ACTIONS = [
  'start',
  'move-to-ready',
  'move-to-backlog',
  'resume',
  'retry-fresh',
  'request-changes',
  'send-message',
  'rerun-review',
  'approve',
  'update-branch',
  'open-pr',
  'mark-done',
  'discard',
  'dismiss-finding',
  'choose-design',
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export const ERROR_CODES = [
  'ILLEGAL_TRANSITION',
  'DEPS_NOT_DONE',
  'T3_UNAVAILABLE',
  'MERGE_CONFLICT',
  'NOTHING_TO_MERGE',
  'DIRTY_ROOT',
  'DIRTY_WORKTREE',
  'DEP_CYCLE',
  'NOT_FOUND',
  'VALIDATION',
  'START_FAILED',
  'GIT_ERROR',
  'NOTHING_TO_RUN',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
