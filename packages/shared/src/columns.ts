// Derived board columns (spec §6.2) and the card pipeline strip (spec §6.4).
import type { Attention, Column, Stage, StageReason } from './enums.ts';

export interface ColumnInput {
  stage: Stage;
  attention: Attention | null;
}

export function columnFor(task: ColumnInput): Column {
  if (task.stage === 'discarded') return 'hidden';
  if (task.attention) return 'needs_input'; // overrides stage columns
  switch (task.stage) {
    case 'backlog':
      return 'backlog';
    case 'ready':
      return 'ready';
    case 'implementing':
      return 'running';
    case 'ai_review':
      return 'ai_review';
    case 'human_review':
      return 'human_review';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
  }
}

export const COLUMN_ORDER: readonly Exclude<Column, 'hidden'>[] = [
  'backlog',
  'ready',
  'running',
  'needs_input',
  'ai_review',
  'human_review',
  'done',
  'failed',
];

export const COLUMN_LABELS: Record<Exclude<Column, 'hidden'>, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  running: 'Running',
  needs_input: 'Needs Input',
  ai_review: 'AI Review',
  human_review: 'Human Review',
  done: 'Done',
  failed: 'Failed',
};

export const COLUMN_EMPTY_TEXT: Record<Exclude<Column, 'hidden'>, string> = {
  backlog: 'Backlog is empty',
  ready: 'Nothing ready to start',
  running: 'Nothing running',
  needs_input: 'No tasks waiting on you',
  ai_review: 'Nothing in AI review',
  human_review: 'Nothing to review',
  done: 'Nothing done yet',
  failed: 'No failures',
};

export const STAGE_REASON_LABELS: Record<StageReason, string> = {
  ai_passed: 'AI passed',
  ai_unresolved: 'AI findings unresolved',
  review_failed: 'AI review failed',
  ai_review_skipped: 'AI review skipped',
  merge_conflict: 'Merge conflict',
  pr_opened: 'PR opened',
  design_options: 'Design options',
  run_failed: 'Run failed',
  run_interrupted: 'Run interrupted',
  run_cancelled: 'Run cancelled',
  agent_blocked: 'Agent blocked',
  thread_missing: 'Thread missing',
  start_failed: 'Start failed',
  auto_approved: 'Auto-approved',
};

export type PipelineStep = 'plan' | 'build' | 'ai_review' | 'human' | 'done';
export type PipelineState = 'done' | 'current' | 'todo';

export const PIPELINE_STEPS: readonly PipelineStep[] = ['plan', 'build', 'ai_review', 'human', 'done'];
export const PIPELINE_LABELS: Record<PipelineStep, string> = {
  plan: 'Plan',
  build: 'Build',
  ai_review: 'AI review',
  human: 'Human',
  done: 'Done',
};

/** State of each pipeline step for a task. The "plan" step is done once the task exists. */
export function pipelineFor(task: { stage: Stage; reviewRound: number }): Record<PipelineStep, PipelineState> {
  const idx: Record<Stage, number> = {
    backlog: 1,
    ready: 1,
    implementing: 1,
    ai_review: 2,
    human_review: 3,
    done: 5,
    failed: 1,
    discarded: 1,
  };
  const current = idx[task.stage];
  const notStarted = task.stage === 'backlog' || task.stage === 'ready';
  const out = {} as Record<PipelineStep, PipelineState>;
  PIPELINE_STEPS.forEach((step, i) => {
    if (i < current) out[step] = 'done';
    else if (i === current && !notStarted) out[step] = 'current';
    else out[step] = 'todo';
  });
  // A fix round re-enters Build after a review: show AI review as reached.
  if (task.stage === 'implementing' && task.reviewRound > 0) out.ai_review = 'done';
  return out;
}
