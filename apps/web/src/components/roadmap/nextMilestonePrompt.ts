import type { MilestoneView, SuggestionView, TaskView } from '@t3-orchestra/shared';

const MAX_LINES = 40;

function capped(lines: string[]): string[] {
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `- …and ${lines.length - MAX_LINES} more`] : lines;
}

/** The prompt "Plan next milestone" puts in the plan composer: where things stand, and what's left over. */
export function nextMilestonePrompt(o: { milestones: MilestoneView[]; tasks: TaskView[]; suggestions: SuggestionView[] }): string {
  const parts = ['Plan the next milestone for this project.'];

  if (o.milestones.length) {
    const lines = o.milestones.map((m) => {
      const mine = o.tasks.filter((t) => t.milestoneId === m.id);
      const done = mine.filter((t) => t.stage === 'done').length;
      const state = mine.length && done === mine.length ? 'done' : `${done}/${mine.length} tasks done`;
      return `- ${m.title} (${state})${m.goal ? `: ${m.goal}` : ''}`;
    });
    parts.push(`Milestones so far:\n${lines.join('\n')}`);
  } else {
    const done = o.tasks.filter((t) => t.stage === 'done');
    if (done.length) parts.push(`Done so far:\n${capped(done.map((t) => `- ${t.title}`)).join('\n')}`);
  }

  const ids = new Set(o.milestones.map((m) => m.id));
  const loose = o.tasks.filter((t) => t.stage !== 'done' && !(t.milestoneId && ids.has(t.milestoneId)));
  if (loose.length) {
    parts.push(`Open tasks not in a milestone (already on the board, don't plan them again; say if one belongs in the new milestone):\n${capped(loose.map((t) => `- #${t.number} ${t.title}`)).join('\n')}`);
  }

  if (o.suggestions.length) {
    parts.push(
      `Follow-ups the agents suggested that nobody has picked up yet. Use the ones worth doing, drop the rest:\n${capped(o.suggestions.map((s) => `- (from #${s.taskNumber}) ${s.text}`)).join('\n')}`,
    );
  }

  parts.push(
    'Propose one new milestone: what should work once it is done, and the tasks to get there. Put every task in that milestone, or in an unfinished milestone above when it finishes that one.',
  );
  return parts.join('\n\n');
}
