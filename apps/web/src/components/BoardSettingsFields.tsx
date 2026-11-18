import {
  ACCEPT_INTO,
  MERGE_STRATEGIES,
  REVIEW_SCORE_MAX,
  REVIEW_SCORE_MIN,
  REVIEW_STRICTNESS,
  type AcceptInto,
  type BoardSettings,
  type MergeStrategy,
  type ReviewStrictness,
} from '@t3-orchestra/shared';
import { useT3Models } from '@/api/settings';
import { FieldRow, NumberInput, SwitchRow } from '@/components/fields';
import { ModelSelect, modelsOf, ProviderSelect } from '@/components/ModelSelect';
import { Select } from '@/components/ui/select';

const MERGE_LABELS: Record<MergeStrategy, string> = {
  local: 'Local merge',
  pr: 'Pull request',
  manual: 'Manual',
};
const MERGE_HINTS: Record<MergeStrategy, string> = {
  local: 'Approve merges the branch into the base branch in the project root.',
  pr: 'Approve asks the agent to push and open a PR.',
  manual: 'Approve only marks the task done; you merge yourself.',
};
const STRICTNESS_LABELS: Record<ReviewStrictness, string> = {
  blocker: 'Blockers only',
  major: 'Major and above',
  minor: 'Minor and above',
};
const ACCEPT_LABELS: Record<AcceptInto, string> = { ready: 'Ready', backlog: 'Backlog' };

// "off" or the limit as a string: tasks scored below it are approved without you.
const AUTO_APPROVE_OPTIONS = [
  { value: 'off', label: 'Off: I review every task' },
  ...Array.from({ length: REVIEW_SCORE_MAX - REVIEW_SCORE_MIN }, (_, i) => {
    const below = REVIEW_SCORE_MIN + 1 + i;
    const range = (from: number, to: number) => (from === to ? `${from}` : `${from}–${to}`);
    return {
      value: String(below),
      label: `Approve ${range(REVIEW_SCORE_MIN, below - 1)} · I review ${range(below, REVIEW_SCORE_MAX)}`,
    };
  }),
];

function autoApproveHint(v: BoardSettings): string {
  if (!v.aiReview) return 'Needs AI review: the reviewer gives each task its score.';
  if (v.autoApproveBelow == null) {
    return `The AI reviewer scores each task 1–${REVIEW_SCORE_MAX} for how much it needs your review. Pick which scores are approved without you; for now every finished task waits for you.`;
  }
  const how = v.mergeStrategy === 'local' ? 'merged' : v.mergeStrategy === 'pr' ? 'sent off as a PR' : 'marked done';
  return `The AI reviewer scores each task 1–${REVIEW_SCORE_MAX} for how much it needs your review. Tasks that pass with ${v.autoApproveBelow - 1} or less are ${how} without you, so tasks that depend on them can start. ${v.autoApproveBelow} and up come to you.`;
}

interface Props {
  value: BoardSettings;
  onChange: (patch: Partial<BoardSettings>) => void;
  /** "change" for dialogs with an explicit Save; "blur" for autosaving pages. */
  mode?: 'blur' | 'change';
  /** Hide the scheduling fields (auto-run, parallel) when they're edited elsewhere. */
  hideScheduling?: boolean;
}

/** Every BoardSettings field (used for board settings, new boards, and app-wide defaults). */
export function BoardSettingsFields({ value, onChange, mode = 'blur', hideScheduling = false }: Props) {
  const catalog = useT3Models().data;
  const setProvider = (defaultProvider: string | null) => {
    const patch: Partial<BoardSettings> = { defaultProvider };
    // Models belong to a provider: drop the ones the new provider doesn't offer.
    const offered = catalog && modelsOf(catalog, defaultProvider);
    for (const k of ['defaultModel', 'plannerModel', 'reviewerModel'] as const) {
      if (offered && value[k] && !offered.some((m) => m.slug === value[k])) patch[k] = null;
    }
    onChange(patch);
  };

  return (
    <div className="divide-y divide-border">
      {!hideScheduling && (
        <>
          <SwitchRow
            label="Auto-run"
            hint="Start Ready tasks automatically when their dependencies are done and a slot is free."
            checked={value.autoRun}
            onCheckedChange={(autoRun) => onChange({ autoRun })}
          />
          <FieldRow label="Max parallel" hint="Tasks running or in AI review at once on this board.">
            <NumberInput
              value={value.maxParallel}
              min={1}
              max={20}
              mode={mode}
              onCommit={(maxParallel) => onChange({ maxParallel })}
            />
          </FieldRow>
        </>
      )}
      <SwitchRow
        label="Avoid overlapping work"
        hint="Don't auto-start a task whose touches overlap a running task's."
        checked={value.avoidOverlap}
        onCheckedChange={(avoidOverlap) => onChange({ avoidOverlap })}
      />
      <FieldRow label="Accepted plan tasks go to" hint="Where tasks land when you accept a plan.">
        <Select
          value={value.acceptInto}
          onValueChange={(acceptInto) => onChange({ acceptInto })}
          options={ACCEPT_INTO.map((v) => ({ value: v, label: ACCEPT_LABELS[v] }))}
        />
      </FieldRow>
      <SwitchRow
        label="AI review"
        hint="A separate reviewer thread checks each finished task before you do."
        checked={value.aiReview}
        onCheckedChange={(aiReview) => onChange({ aiReview })}
      />
      <SwitchRow
        label="Skip AI review for trivial tasks"
        checked={value.skipReviewForTrivial}
        disabled={!value.aiReview}
        onCheckedChange={(skipReviewForTrivial) => onChange({ skipReviewForTrivial })}
      />
      <FieldRow label="Max fix rounds" hint="AI review → fix cycles before handing over to you.">
        <NumberInput
          value={value.maxFixRounds}
          min={0}
          max={10}
          mode={mode}
          disabled={!value.aiReview}
          onCommit={(maxFixRounds) => onChange({ maxFixRounds })}
        />
      </FieldRow>
      <FieldRow label="Review strictness" hint="Findings at or above this severity trigger a fix round.">
        <Select
          value={value.reviewStrictness}
          disabled={!value.aiReview}
          onValueChange={(reviewStrictness) => onChange({ reviewStrictness })}
          options={REVIEW_STRICTNESS.map((v) => ({ value: v, label: STRICTNESS_LABELS[v] }))}
        />
      </FieldRow>
      <FieldRow label="Auto-approve tasks" hint={autoApproveHint(value)}>
        <Select
          value={value.autoApproveBelow == null ? 'off' : String(value.autoApproveBelow)}
          disabled={!value.aiReview}
          onValueChange={(v) => onChange({ autoApproveBelow: v === 'off' ? null : Number(v) })}
          options={AUTO_APPROVE_OPTIONS}
        />
      </FieldRow>
      <FieldRow label="Merge strategy" hint={MERGE_HINTS[value.mergeStrategy]}>
        <Select
          value={value.mergeStrategy}
          onValueChange={(mergeStrategy) => onChange({ mergeStrategy })}
          options={MERGE_STRATEGIES.map((v) => ({ value: v, label: MERGE_LABELS[v] }))}
        />
      </FieldRow>
      <FieldRow label="Default provider" hint="The T3 provider for this board's threads. The models below are its models.">
        <ProviderSelect mode={mode} value={value.defaultProvider} noneLabel="Project default" onChange={setProvider} />
      </FieldRow>
      <FieldRow label="Default model" hint="Model for implementation runs.">
        <ModelSelect
          mode={mode}
          provider={value.defaultProvider}
          value={value.defaultModel}
          noneLabel="Project default"
          onChange={(defaultModel) => onChange({ defaultModel })}
        />
      </FieldRow>
      <FieldRow label="Planner model">
        <ModelSelect
          mode={mode}
          provider={value.defaultProvider}
          value={value.plannerModel}
          noneLabel="Default model"
          onChange={(plannerModel) => onChange({ plannerModel })}
        />
      </FieldRow>
      <FieldRow label="Reviewer model">
        <ModelSelect
          mode={mode}
          provider={value.defaultProvider}
          value={value.reviewerModel}
          noneLabel="Default model"
          onChange={(reviewerModel) => onChange({ reviewerModel })}
        />
      </FieldRow>
    </div>
  );
}

/** Pick the BoardSettings fields out of a BoardView. */
export function boardSettingsOf(b: BoardSettings): BoardSettings {
  return {
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
  };
}
