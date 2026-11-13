import {
  COLUMN_LABELS,
  columnFor,
  STAGE_REASON_LABELS,
  type Attention,
  type Column,
  type RunKind,
  type Severity,
  type Stage,
  type StageReason,
  type TaskDepView,
} from '@t3-orchestra/shared';

export type VisibleColumn = Exclude<Column, 'hidden'>;
/** Board columns plus the opt-in "discarded" lane. */
export type BoardLane = VisibleColumn | 'discarded';

/** Tailwind classes per lane, kept literal so Tailwind can see them. */
export const LANE_STYLE: Record<BoardLane, { border: string; text: string; bg: string; dot: string }> = {
  backlog: {
    border: 'border-t-stage-backlog',
    text: 'text-stage-backlog',
    bg: 'bg-stage-backlog/12',
    dot: 'bg-stage-backlog',
  },
  ready: { border: 'border-t-stage-ready', text: 'text-stage-ready', bg: 'bg-stage-ready/12', dot: 'bg-stage-ready' },
  running: {
    border: 'border-t-stage-running',
    text: 'text-stage-running',
    bg: 'bg-stage-running/12',
    dot: 'bg-stage-running',
  },
  needs_input: {
    border: 'border-t-stage-needs-input',
    text: 'text-stage-needs-input',
    bg: 'bg-stage-needs-input/12',
    dot: 'bg-stage-needs-input',
  },
  ai_review: {
    border: 'border-t-stage-ai-review',
    text: 'text-stage-ai-review',
    bg: 'bg-stage-ai-review/12',
    dot: 'bg-stage-ai-review',
  },
  human_review: {
    border: 'border-t-stage-human-review',
    text: 'text-stage-human-review',
    bg: 'bg-stage-human-review/12',
    dot: 'bg-stage-human-review',
  },
  done: { border: 'border-t-stage-done', text: 'text-stage-done', bg: 'bg-stage-done/12', dot: 'bg-stage-done' },
  failed: {
    border: 'border-t-stage-failed',
    text: 'text-stage-failed',
    bg: 'bg-stage-failed/12',
    dot: 'bg-stage-failed',
  },
  discarded: {
    border: 'border-t-stage-discarded',
    text: 'text-stage-discarded',
    bg: 'bg-stage-discarded/12',
    dot: 'bg-stage-discarded',
  },
};

export const LANE_LABELS: Record<BoardLane, string> = { ...COLUMN_LABELS, discarded: 'Discarded' };

export function laneFor(task: { stage: Stage; attention: Attention | null }): BoardLane {
  const col = columnFor(task);
  return col === 'hidden' ? 'discarded' : col;
}

/** The lane a stage maps to, ignoring attention. */
export function stageLane(stage: Stage): BoardLane {
  return laneFor({ stage, attention: null });
}

/** Human label for a stage, using the column vocabulary ("Human Review", "Running"…). */
export function stageLabel(stage: Stage): string {
  return LANE_LABELS[stageLane(stage)];
}

export function reasonLabel(reason: StageReason | null | undefined): string | null {
  if (!reason) return null;
  return STAGE_REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
}

export const RUN_KIND_LABELS: Record<RunKind, string> = {
  spec: 'Drafting the spec',
  plan: 'Planning',
  implement: 'Implementing',
  fix: 'Fix round',
  changes: 'Applying changes',
  resume: 'Resuming',
  rebase: 'Updating branch',
  followup: 'Follow-up',
  pr: 'Opening PR',
  design: 'Building chosen design',
  options: 'Making design options',
  review: 'Review round',
  insight: 'Answering',
  ideas: 'Generating ideas',
  import: 'Learning the project',
  security: 'Security audit',
  knowledge: 'Reading context files',
};

export const ATTENTION_LABELS: Record<Attention, string> = {
  question: '❓ Asking a question',
  approval: '🔐 Waiting for approval',
  waiting: 'Waiting',
};

export const SEVERITY_STYLE: Record<Severity, string> = {
  blocker: 'bg-destructive/15 text-destructive border-destructive/30',
  major: 'bg-warning/15 text-warning border-warning/30',
  minor: 'bg-info/12 text-info border-info/25',
  nit: 'bg-muted text-muted-foreground border-border',
};

/** "#2 (Human Review)" */
export function depLabel(dep: TaskDepView): string {
  return `#${dep.number} (${stageLabel(dep.stage)})`;
}

/** "#2 (Human Review) and #3 (Running)" */
export function joinDeps(deps: readonly TaskDepView[]): string {
  const parts = deps.map(depLabel);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
