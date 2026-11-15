// Live plan checks (spec §5.3): cycles, unknown deps, empty fields, max tasks, selection gaps.
import { findCycle, MAX_PLAN_TASKS, unknownDeps, type PlanTask } from '@t3-orchestra/shared';

export interface PlanIssue {
  level: 'error' | 'warning';
  kind: 'cycle' | 'unknown_dep' | 'field' | 'too_many' | 'selection';
  message: string;
  keys: string[];
}

export function checkProposals(tasks: readonly PlanTask[], maxTasks: number, selected: ReadonlySet<string>): PlanIssue[] {
  const issues: PlanIssue[] = [];

  const cycle = findCycle(tasks);
  if (cycle) issues.push({ level: 'error', kind: 'cycle', message: `Dependency cycle: ${cycle.join(' → ')}`, keys: cycle });

  for (const [from, missing] of unknownDeps(tasks)) {
    issues.push({ level: 'error', kind: 'unknown_dep', message: `${from} depends on unknown task ${missing}`, keys: [from] });
  }

  for (const t of tasks) {
    if (t.title.trim().length < 3) issues.push({ level: 'error', kind: 'field', message: `${t.key} needs a title (3+ characters)`, keys: [t.key] });
    if (!t.description.trim()) issues.push({ level: 'error', kind: 'field', message: `${t.key} needs a description`, keys: [t.key] });
    if (t.acceptanceCriteria.filter((c) => c.trim()).length === 0) {
      issues.push({ level: 'error', kind: 'field', message: `${t.key} needs at least one acceptance criterion`, keys: [t.key] });
    }
  }

  const limit = Math.min(maxTasks, MAX_PLAN_TASKS);
  if (tasks.length > limit) {
    issues.push({
      level: tasks.length > MAX_PLAN_TASKS ? 'error' : 'warning',
      kind: 'too_many',
      message: `${tasks.length} tasks — more than the limit of ${limit}`,
      keys: [],
    });
  }

  const byKey = new Map(tasks.map((t) => [t.key, t]));
  for (const t of tasks) {
    if (!selected.has(t.key)) continue;
    const missing = t.dependsOn.filter((d) => byKey.has(d) && !selected.has(d));
    if (missing.length) {
      issues.push({
        level: 'warning',
        kind: 'selection',
        message: `${t.key} depends on ${missing.join(', ')}, which ${missing.length === 1 ? "isn't" : "aren't"} selected`,
        keys: [t.key],
      });
    }
  }

  return issues;
}

/** Selected keys plus everything they (transitively) depend on. */
export function withDependencies(tasks: readonly PlanTask[], selected: ReadonlySet<string>): Set<string> {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const out = new Set(selected);
  const stack = [...selected];
  while (stack.length) {
    const key = stack.pop() as string;
    for (const d of byKey.get(key)?.dependsOn ?? []) {
      if (byKey.has(d) && !out.has(d)) {
        out.add(d);
        stack.push(d);
      }
    }
  }
  return out;
}

/** Next free proposal key ("T7"). */
export function nextKey(tasks: readonly PlanTask[]): string {
  const max = tasks.reduce((m, t) => Math.max(m, Number(t.key.slice(1)) || 0), 0);
  return `T${max + 1}`;
}
