// zod contracts: agent result blocks (spec §9) and REST request bodies (spec §11.3).
import { z } from 'zod';
import {
  ACCEPT_INTO,
  ALL_IDEA_CATEGORIES,
  CATEGORIES,
  COMPLEXITIES,
  DESIGN_CHOICE_MODES,
  IDEA_DIFFICULTIES,
  IDEA_IMPACTS,
  IDEA_KINDS,
  MERGE_STRATEGIES,
  PRIORITIES,
  REVIEW_STRICTNESS,
  SEVERITIES,
} from './enums.ts';
import { duplicateKeys, findCycle, unknownDeps } from './graph.ts';
import { MARKETING_SOURCE_KINDS } from './marketing.ts';
import { RunConfig } from './projectRun.ts';

export const MAX_PLAN_TASKS = 40;

// ---------------------------------------------------------------------------
// Agent result blocks
// ---------------------------------------------------------------------------

export const PlanTask = z.object({
  key: z.string().regex(/^T\d+$/, 'key must look like T1, T2, …'),
  title: z.string().min(3).max(120),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  complexity: z.enum(COMPLEXITIES),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES).default('medium'),
  dependsOn: z.array(z.string()).default([]),
  touches: z.array(z.string()).default([]),
  /** Title of the milestone the task belongs to (one of the plan's milestones, or one already on the board). */
  milestone: z.string().trim().max(120).nullish(),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const PlanMilestone = z.object({
  title: z.string().trim().min(1).max(120),
  /** What is true once the milestone is done. */
  goal: z.string().default(''),
});
export type PlanMilestone = z.infer<typeof PlanMilestone>;

type DepCheckable = { tasks: Array<{ key: string; dependsOn: string[] }> };

export function checkPlanGraph(value: DepCheckable, ctx: z.RefinementCtx): void {
  for (const key of duplicateKeys(value.tasks)) {
    ctx.addIssue({ code: 'custom', message: `duplicate task key ${key}`, path: ['tasks'] });
  }
  for (const [from, missing] of unknownDeps(value.tasks)) {
    ctx.addIssue({ code: 'custom', message: `${from} depends on unknown key ${missing}`, path: ['tasks'] });
  }
  const cycle = findCycle(value.tasks);
  if (cycle) {
    ctx.addIssue({ code: 'custom', message: `dependency cycle: ${cycle.join(' → ')}`, path: ['tasks'] });
  }
}

export const PlanResult = z
  .object({
    summary: z.string(),
    assumptions: z.array(z.string()).default([]),
    openQuestions: z.array(z.string()).default([]),
    /** Milestones in the order they should be finished (optional; older plans have none). */
    milestones: z.array(PlanMilestone).default([]),
    tasks: z.array(PlanTask).min(1).max(MAX_PLAN_TASKS),
  })
  .superRefine(checkPlanGraph);
export type PlanResult = z.infer<typeof PlanResult>;

export const MAX_SPEC_QUESTIONS = 12;

/** One question the planner asks while it drafts a spec, answered in T3 Orchestra. */
export const SpecQuestion = z.object({
  question: z.string().trim().min(1),
  /** What the answer changes in the plan. */
  why: z.string().default(''),
  /** Likely answers to pick from (the user can also write their own). */
  options: z.array(z.string().trim().min(1)).max(6).default([]),
  /** The option (or a short answer) the planner would pick. */
  recommended: z.string().trim().nullish(),
});
export type SpecQuestion = z.infer<typeof SpecQuestion>;

/** A spec round: the whole spec so far plus the questions that are still open. */
export const SpecResult = z.object({
  /** Markdown: the complete spec, not a diff. */
  spec: z.string().trim().min(1),
  /** One or two sentences on what changed since the previous round ('' on the first). */
  changes: z.string().default(''),
  questions: z.array(SpecQuestion).max(MAX_SPEC_QUESTIONS).default([]),
});
export type SpecResult = z.infer<typeof SpecResult>;

export const MAX_DESIGN_OPTIONS = 8;

/** One HTML mock-up the implementer saved in the round's design folder. */
export const DesignOptionInfo = z.object({
  /** File name in the round's folder, e.g. `a-sidebar-nav.html`. */
  file: z.string().trim().min(1).max(160),
  title: z.string().trim().max(120).default(''),
  /** The idea and its trade-off, one or two lines. */
  summary: z.string().default(''),
});
export type DesignOptionInfo = z.infer<typeof DesignOptionInfo>;

export const ImplementResult = z.object({
  /** `options`: the agent stopped before building and saved HTML design options for the user to pick from. */
  status: z.enum(['done', 'blocked', 'options']),
  /** 1-3 short lines for the human reviewer. Optional: older results and overridden prompts lack it. */
  tldr: z.string().optional(),
  summary: z.string(),
  changes: z.array(z.string()).default([]),
  testsRun: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
  blockedReason: z.string().optional(),
  /** Options only: what the user should decide. */
  question: z.string().optional(),
  options: z.array(DesignOptionInfo).max(MAX_DESIGN_OPTIONS * 2).default([]),
});
export type ImplementResult = z.infer<typeof ImplementResult>;

export const ReviewFinding = z.object({
  severity: z.enum(SEVERITIES),
  file: z.string().nullish(),
  line: z.number().int().nullish(),
  title: z.string().min(1),
  detail: z.string().default(''),
  suggestion: z.string().nullish(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const REVIEW_SCORE_MIN = 1;
export const REVIEW_SCORE_MAX = 10;

/** The reviewer's 1-10 estimate of how much the task needs a human look. */
export const HumanReviewScore = z.object({
  score: z.number().min(REVIEW_SCORE_MIN).max(REVIEW_SCORE_MAX).transform(Math.round),
  reason: z.string().default(''),
});
export type HumanReviewScore = z.infer<typeof HumanReviewScore>;

export const ReviewResult = z.object({
  verdict: z.enum(['pass', 'changes_requested']),
  summary: z.string(),
  findings: z.array(ReviewFinding).default([]),
  // A missing or malformed score never fails the review; the task then simply goes to the human.
  humanReview: HumanReviewScore.optional().catch(undefined),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

export const MAX_IDEAS = 12;

export const IdeaProposal = z.object({
  title: z.string().trim().min(3).max(120),
  /** One or two sentences for the card. */
  description: z.string().trim().min(1),
  /** Markdown for the coding agent: where, how, what to watch out for. Goes into the task. */
  details: z.string().default(''),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  touches: z.array(z.string()).default([]),
  impact: z.enum(IDEA_IMPACTS),
  difficulty: z.enum(IDEA_DIFFICULTIES),
});
export type IdeaProposal = z.infer<typeof IdeaProposal>;

export const IdeasResult = z.object({
  summary: z.string().default(''),
  // None is a valid answer ("the docs are in good shape"); the summary then says why.
  ideas: z.array(IdeaProposal).max(MAX_IDEAS),
});
export type IdeasResult = z.infer<typeof IdeasResult>;

/** A marketing task: code to build (it goes on the board) or something to do, with copy ready to paste. */
export const MarketingProposal = IdeaProposal.extend({
  kind: z.enum(IDEA_KINDS),
  draft: z.string().default(''),
});
export type MarketingProposal = z.infer<typeof MarketingProposal>;

export const MarketingResult = z.object({
  summary: z.string().default(''),
  /** What the product is and who it's for, when the board has no marketing brief yet. */
  suggestedBrief: z.string().default(''),
  ideas: z.array(MarketingProposal).max(MAX_IDEAS),
});
export type MarketingResult = z.infer<typeof MarketingResult>;

export const MAX_IMPORT_NEXT_STEPS = 10;

/** What the import agent learned about a project from its T3 threads and its code. */
export const ImportResult = z.object({
  /** One or two sentences for the board: what the project is and where it stands. */
  summary: z.string().trim().min(1).max(600),
  /** Markdown: what the project is, who it's for, the stack, the layout, how to run and test it. */
  about: z.string().trim().min(1).max(12_000),
  /** Markdown: what is done, what is half-done or in flight, known problems, decisions made. */
  state: z.string().trim().min(1).max(12_000),
  nextSteps: z.array(z.string().trim().min(1).max(300)).max(MAX_IMPORT_NEXT_STEPS).default([]),
});
export type ImportResult = z.infer<typeof ImportResult>;

/** Turns zod issues into short human-readable strings (used in the planner correction message). */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.length ? i.path.join('.') : '(root)';
    return `${path}: ${i.message}`;
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const BoardSettings = z.object({
  autoRun: z.boolean(),
  maxParallel: z.number().int().min(1).max(20),
  acceptInto: z.enum(ACCEPT_INTO),
  aiReview: z.boolean(),
  skipReviewForTrivial: z.boolean(),
  maxFixRounds: z.number().int().min(0).max(10),
  reviewStrictness: z.enum(REVIEW_STRICTNESS),
  avoidOverlap: z.boolean(),
  mergeStrategy: z.enum(MERGE_STRATEGIES),
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  plannerModel: z.string().nullable(),
  reviewerModel: z.string().nullable(),
  /** AI-passed tasks scored below this are approved without the user; null = review everything. */
  autoApproveBelow: z.number().int().min(REVIEW_SCORE_MIN + 1).max(REVIEW_SCORE_MAX).nullable(),
});
export type BoardSettings = z.infer<typeof BoardSettings>;

export const DEFAULT_BOARD_SETTINGS: BoardSettings = {
  autoRun: false,
  maxParallel: 3,
  acceptInto: 'ready',
  aiReview: true,
  skipReviewForTrivial: true,
  maxFixRounds: 2,
  reviewStrictness: 'major',
  avoidOverlap: true,
  mergeStrategy: 'local',
  defaultProvider: null,
  defaultModel: null,
  plannerModel: null,
  reviewerModel: null,
  autoApproveBelow: null,
};

export const NotificationSettings = z.object({
  desktop: z.boolean(),
  sound: z.boolean(),
  task_attention: z.boolean(),
  plan_input: z.boolean(),
  plan_ready: z.boolean(),
  human_review: z.boolean(),
  task_failed: z.boolean(),
  board_done: z.boolean(),
  t3_down: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const AppSettings = z.object({
  t3CliPath: z.string().nullable(),
  pollActiveMs: z.number().int().min(500).max(60_000),
  pollIdleMs: z.number().int().min(1000).max(600_000),
  staleAfterMinutes: z.number().int().min(1).max(24 * 60),
  globalMaxParallel: z.number().int().min(1).max(50),
  pauseAll: z.boolean(),
  /** Settle a task's T3 threads (task and reviews) in T3's sidebar once the task is Done. */
  settleDoneThreads: z.boolean(),
  notifications: NotificationSettings,
  boardDefaults: BoardSettings,
});
export type AppSettings = z.infer<typeof AppSettings>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  t3CliPath: null,
  pollActiveMs: 2000,
  pollIdleMs: 15_000,
  staleAfterMinutes: 15,
  globalMaxParallel: 6,
  pauseAll: false,
  settleDoneThreads: true,
  notifications: {
    desktop: true,
    sound: false,
    task_attention: true,
    plan_input: true,
    plan_ready: true,
    human_review: true,
    task_failed: true,
    board_done: true,
    t3_down: true,
  },
  boardDefaults: DEFAULT_BOARD_SETTINGS,
};

export const PatchSettings = AppSettings.extend({
  notifications: NotificationSettings.partial(),
  boardDefaults: BoardSettings.partial(),
}).partial();
export type PatchSettings = z.infer<typeof PatchSettings>;

// ---------------------------------------------------------------------------
// REST request bodies
// ---------------------------------------------------------------------------

export const CreateBoardBody = BoardSettings.partial().extend({
  name: z.string().trim().min(1).max(80),
  projectPath: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1).optional(),
  /** Start an import right away: an agent reads the project's T3 threads and writes the board brief. */
  importFromT3: z.boolean().optional(),
});
export type CreateBoardBody = z.infer<typeof CreateBoardBody>;

export const PatchBoardBody = BoardSettings.partial().extend({
  name: z.string().trim().min(1).max(80).optional(),
  baseBranch: z.string().trim().min(1).optional(),
  brief: z.string().optional(),
  marketingBrief: z.string().max(20_000).optional(),
  securityBrief: z.string().max(20_000).optional(),
  securityReview: z.boolean().optional(),
  securityAutoScan: z.boolean().optional(),
  contextAutoBuild: z.boolean().optional(),
  contextInPrompts: z.boolean().optional(),
  runConfig: RunConfig.nullable().optional(),
});
export type PatchBoardBody = z.infer<typeof PatchBoardBody>;

export const ValidateProjectBody = z.object({
  projectPath: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1).optional(),
});
export type ValidateProjectBody = z.infer<typeof ValidateProjectBody>;

export const PlanOptions = z.object({
  plannerModel: z.string().nullable().optional(),
  maxTasks: z.number().int().min(1).max(MAX_PLAN_TASKS).default(20),
  askQuestions: z.boolean().default(true),
  extraGuidance: z.string().default(''),
  /** Draft a spec with the user (questions answered in T3 Orchestra) before proposing tasks; missing on older plans. */
  specFirst: z.boolean().optional(),
});
export type PlanOptions = z.infer<typeof PlanOptions>;

export const CreatePlanBody = z.object({
  prompt: z.string().trim().min(1),
  options: PlanOptions.default({ maxTasks: 20, askQuestions: true, extraGuidance: '' }),
});
export type CreatePlanBody = z.infer<typeof CreatePlanBody>;

/** A proposal as edited by the user: like PlanTask but tolerant while editing. */
export const ProposalPatch = PlanTask.omit({ key: true }).partial();
export type ProposalPatch = z.infer<typeof ProposalPatch>;

export const ReplaceProposalsBody = z.object({
  tasks: z.array(PlanTask).max(MAX_PLAN_TASKS),
});
export type ReplaceProposalsBody = z.infer<typeof ReplaceProposalsBody>;

/** An answer to one of the plan's open questions (the question text as the planner wrote it). */
export const PlanAnswer = z.object({ question: z.string().trim().min(1), answer: z.string().trim().min(1) });
export type PlanAnswer = z.infer<typeof PlanAnswer>;

/** Free-text feedback, answers to open questions, or both. */
export const RefinePlanBody = z
  .object({
    feedback: z.string().trim().default(''),
    answers: z.array(PlanAnswer).max(50).default([]),
  })
  .refine((b) => b.feedback.length > 0 || b.answers.length > 0, { message: 'write feedback or answer at least one question' });
export type RefinePlanBody = z.infer<typeof RefinePlanBody>;
export type RefinePlanInput = z.input<typeof RefinePlanBody>;

/** "Generate tasks": answers or a note not sent yet go along with the spec. */
export const PlanFromSpecBody = z.object({
  feedback: z.string().trim().default(''),
  answers: z.array(PlanAnswer).max(50).default([]),
});
export type PlanFromSpecBody = z.infer<typeof PlanFromSpecBody>;
export type PlanFromSpecInput = z.input<typeof PlanFromSpecBody>;

/** The user's own version of the current spec. */
export const EditSpecBody = z.object({ spec: z.string().trim().min(1).max(100_000) });
export type EditSpecBody = z.infer<typeof EditSpecBody>;
export const AcceptPlanBody = z.object({ keys: z.array(z.string()).optional() });

export const CreateTaskBody = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().default(''),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  dependsOn: z.array(z.string()).default([]), // task ids
  complexity: z.enum(COMPLEXITIES).default('medium'),
  category: z.enum(CATEGORIES).default('feature'),
  priority: z.enum(PRIORITIES).default('medium'),
  touches: z.array(z.string()).default([]),
  providerOverride: z.string().nullable().default(null),
  modelOverride: z.string().nullable().default(null),
  skipAiReview: z.boolean().default(false),
  milestoneId: z.string().nullable().default(null),
});
export type CreateTaskBody = z.infer<typeof CreateTaskBody>;

export const PatchTaskBody = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string(),
    acceptanceCriteria: z.array(z.string().min(1)),
    dependsOn: z.array(z.string()), // task ids
    complexity: z.enum(COMPLEXITIES),
    category: z.enum(CATEGORIES),
    priority: z.enum(PRIORITIES),
    touches: z.array(z.string()),
    position: z.number(),
    providerOverride: z.string().nullable(),
    modelOverride: z.string().nullable(),
    skipAiReview: z.boolean(),
    milestoneId: z.string().nullable(),
    /** Auto-run starts this Ready task next (one per board; setting it clears the others). */
    runNext: z.boolean(),
  })
  .partial();
export type PatchTaskBody = z.infer<typeof PatchTaskBody>;

export const CreateMilestoneBody = z.object({
  title: z.string().trim().min(1).max(120),
  goal: z.string().default(''),
});
export type CreateMilestoneBody = z.infer<typeof CreateMilestoneBody>;

export const PatchMilestoneBody = z
  .object({
    title: z.string().trim().min(1).max(120),
    goal: z.string(),
    position: z.number(),
  })
  .partial();
export type PatchMilestoneBody = z.infer<typeof PatchMilestoneBody>;

/** One agent follow-up suggestion: the task that suggested it and the suggestion's exact text. */
export const SuggestionRef = z.object({ taskId: z.string(), text: z.string().trim().min(1) });
export type SuggestionRef = z.infer<typeof SuggestionRef>;

export const AddSuggestionsBody = z.object({
  items: z.array(SuggestionRef).min(1).max(200),
  milestoneId: z.string().nullable().default(null),
});
export type AddSuggestionsBody = z.infer<typeof AddSuggestionsBody>;

/** Dismiss suggestions, or bring dismissed ones back with `undo`. */
export const DismissSuggestionsBody = z.object({
  items: z.array(SuggestionRef).min(1).max(200),
  undo: z.boolean().default(false),
});
export type DismissSuggestionsBody = z.infer<typeof DismissSuggestionsBody>;

/** A question for Insights (POST /api/boards/:id/insights starts a chat, /api/insights/:id/messages continues it). */
export const InsightMessageBody = z.object({ text: z.string().trim().min(1).max(20_000) });
export type InsightMessageBody = z.infer<typeof InsightMessageBody>;

export const PatchInsightChatBody = z.object({ title: z.string().trim().min(1).max(120) });
export type PatchInsightChatBody = z.infer<typeof PatchInsightChatBody>;

/** POST /api/boards/:id/ideas: generate ideas (or marketing tasks) of one category. */
export const GenerateIdeasBody = z.object({ category: z.enum(ALL_IDEA_CATEGORIES) });
export type GenerateIdeasBody = z.infer<typeof GenerateIdeasBody>;

/** Dismiss an idea, or bring it back with `undo`. Also the body of POST /api/ideas/:id/done. */
export const DismissIdeaBody = z.object({ undo: z.boolean().default(false) });
export type DismissIdeaBody = z.infer<typeof DismissIdeaBody>;

const sourceConfig = z.record(z.string(), z.string().trim().max(2000));

/** POST /api/boards/:id/marketing/sources: connect a metric source. `secret` is the kind's secret field. */
export const CreateMarketingSourceBody = z.object({
  kind: z.enum(MARKETING_SOURCE_KINDS),
  name: z.string().trim().max(80).optional(),
  config: sourceConfig.default({}),
  secret: z.string().trim().max(4000).optional(),
});
export type CreateMarketingSourceBody = z.infer<typeof CreateMarketingSourceBody>;

/** PATCH /api/marketing/sources/:id. Leave `secret` out to keep it; null or '' removes it. */
export const PatchMarketingSourceBody = z.object({
  name: z.string().trim().max(80).optional(),
  config: sourceConfig.optional(),
  secret: z.string().trim().max(4000).nullable().optional(),
});
export type PatchMarketingSourceBody = z.infer<typeof PatchMarketingSourceBody>;

/** POST /api/marketing/sources/:id/values: log a value of a manual metric. */
export const MetricValueBody = z.object({ value: z.number() });
export type MetricValueBody = z.infer<typeof MetricValueBody>;

/** An option the user picked, from any round of the task, with what to take from it. */
export const DesignPick = z.object({
  round: z.number().int().min(1),
  file: z.string().trim().min(1).max(160),
  note: z.string().trim().max(4000).default(''),
});
export type DesignPick = z.infer<typeof DesignPick>;

/** The user's answer to a round of design options: build the picks, or ask for another round. */
export const DesignChoice = z
  .object({
    mode: z.enum(DESIGN_CHOICE_MODES),
    picks: z.array(DesignPick).max(MAX_DESIGN_OPTIONS).default([]),
    notes: z.string().trim().max(20_000).default(''),
  })
  .refine((c) => c.picks.length > 0 || c.notes.length > 0, { message: 'pick an option or write a note' });
export type DesignChoice = z.infer<typeof DesignChoice>;
export type DesignChoiceInput = z.input<typeof DesignChoice>;

/** Body for POST /api/tasks/:id/actions/:action. Every field is optional; actions use what they need. */
export const TaskActionBody = z
  .object({
    text: z.string().optional(),
    note: z.string().optional(),
    force: z.boolean().optional(),
    findingId: z.string().optional(),
    /** choose-design. */
    design: DesignChoice.optional(),
  })
  .default({});
export type TaskActionBody = z.infer<typeof TaskActionBody>;
