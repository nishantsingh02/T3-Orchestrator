import type { PlanStatus } from '@t3-orchestra/shared';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';

const LABELS: Record<PlanStatus, string> = {
  speccing: 'Writing spec',
  spec_review: 'Spec review',
  planning: 'Planning',
  needs_input: 'Needs input',
  ready: 'Ready for review',
  refining: 'Refining',
  accepted: 'Accepted',
  discarded: 'Discarded',
  failed: 'Failed',
};

const VARIANTS: Record<PlanStatus, BadgeProps['variant']> = {
  speccing: 'primary',
  spec_review: 'warning',
  planning: 'primary',
  needs_input: 'warning',
  ready: 'success',
  refining: 'primary',
  accepted: 'default',
  discarded: 'default',
  failed: 'destructive',
};

export function planStatusLabel(s: PlanStatus): string {
  return LABELS[s];
}

export function PlanStatusBadge({ status }: { status: PlanStatus }) {
  const busy = status === 'speccing' || status === 'planning' || status === 'refining';
  return (
    <Badge variant={VARIANTS[status]}>
      {busy && <Spinner className="size-2.5 text-current" />}
      {LABELS[status]}
    </Badge>
  );
}
