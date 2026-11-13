// Turns `events` rows into readable timeline lines. The server's event vocabulary is open-ended,
// so this handles the transition events from spec §6.3 explicitly and humanises the rest.
import type { EventView, Stage } from '@t3-orchestra/shared';
import { stageLabel } from './stage';

const ACTORS: Record<string, string> = {
  user: 'you',
  scheduler: 'scheduler',
  run: 'the agent',
  review: 'the reviewer',
  thread: 'T3',
  pr: 'GitHub',
  plan: 'plan',
  system: 'system',
};

const TRANSITION_TEXT: Record<string, string> = {
  'user.create': 'created',
  'plan.accepted': 'created from plan',
  'user.move_to_ready': 'moved to Ready',
  'user.move_to_backlog': 'moved to Backlog',
  'user.start': 'started',
  'scheduler.start': 'started',
  'run.done': 'run finished',
  'run.blocked': 'agent reported it is blocked',
  'run.failed': 'run did not complete',
  'run.start_failed': 'thread could not be started',
  'review.pass': 'AI review passed',
  'review.changes': 'AI review requested changes',
  'review.failed': 'AI review failed',
  'user.rerun_review': 'AI review re-run',
  'user.request_changes': 'changes requested',
  'user.send_message': 'message sent to the agent',
  'user.approve': 'approved',
  'auto.approve': 'auto-approved (review score under the limit)',
  'user.update_branch': 'asked the agent to update the branch',
  'user.open_pr': 'asked the agent to open a PR',
  'user.mark_done': 'marked done',
  'pr.merged': 'PR merged',
  'user.resume': 'resumed',
  'user.retry_fresh': 'retried with a fresh thread',
  'user.discard': 'discarded',
  'thread.missing': 'T3 thread disappeared',
};

const TYPE_TEXT: Record<string, string> = {
  task_created: 'task created',
  task_updated: 'task edited',
  task_edited: 'task edited',
  run_created: 'run created',
  thread_started: 'T3 thread started',
  thread_recovered: 'recovered the T3 thread after an unconfirmed start',
  illegal_transition: 'ignored an action that is not allowed in this stage',
  run_started: 'run started',
  run_finished: 'run finished',
  run_linked: 'linked an existing T3 thread',
  merged: 'merged into base',
  merge_conflict: 'merge conflict — merge aborted',
  auto_approve_failed: 'auto-approve failed, so it waits for you',
  finding_dismissed: 'finding dismissed',
  follow_up_created: 'follow-up task created',
  attention_set: 'agent needs input',
  attention_cleared: 'agent resumed',
  external_activity: 'agent activity outside T3 Orchestra',
  background_wait: 'turn ended, waiting on background work',
  threads_settled: 'T3 threads settled',
  plan_created: 'plan created',
  plan_version: 'new plan version',
  plan_refine: 'plan refinement requested',
  plan_ready: 'plan ready for review',
  plan_input: 'planner needs input',
  plan_failed: 'planner output could not be used',
  plan_correction_sent: 'asked the planner to fix its output',
  plan_accepted: 'plan accepted',
  plan_discarded: 'plan discarded',
  spec_round: 'new spec draft',
  spec_refine: 'answers sent to the planner',
  spec_edited: 'spec edited',
  spec_accepted: 'tasks requested from the spec',
  board_created: 'board created',
  board_updated: 'board settings changed',
  board_done: 'all tasks done',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function humanize(type: string): string {
  return type.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STAGES = new Set(['backlog', 'ready', 'implementing', 'ai_review', 'human_review', 'done', 'failed', 'discarded']);

function asStage(v: unknown): Stage | null {
  return typeof v === 'string' && STAGES.has(v) ? (v as Stage) : null;
}

export interface DescribedEvent {
  text: string;
  detail: string | null;
  tone: 'default' | 'good' | 'warn' | 'bad';
}

export function describeEvent(e: EventView): DescribedEvent {
  const p = e.payload ?? {};
  const eventName = str(p.event) ?? (e.type.includes('.') ? e.type : null);
  const to = asStage(p.to);
  const from = asStage(p.from);
  const actorKey = str(p.actor) ?? eventName?.split('.')[0] ?? null;
  const actor = actorKey ? ACTORS[actorKey] : null;

  let text: string;
  const approved = eventName === 'user.approve' || eventName === 'auto.approve';
  const auto = eventName === 'auto.approve' ? 'auto-' : '';
  if (approved && to === 'human_review') {
    text = `${auto}approve: merge conflicted — merge aborted`;
  } else if (approved && (str(p.mergeSha) || p.strategy === 'local')) {
    text = `${auto}approved and merged into base`;
  } else if (eventName && TRANSITION_TEXT[eventName]) {
    text = TRANSITION_TEXT[eventName];
    if (to && !text.toLowerCase().includes(stageLabel(to).toLowerCase())) text += ` → ${stageLabel(to)}`;
  } else if (to) {
    text = from ? `moved from ${stageLabel(from)} to ${stageLabel(to)}` : `moved to ${stageLabel(to)}`;
  } else {
    text = TYPE_TEXT[e.type] ?? humanize(e.type);
    if (e.type === 'run_created' || e.type === 'thread_started') {
      const kind = str(p.kind);
      if (kind) text = `${kind}${typeof p.round === 'number' ? ` r${p.round}` : ''} · ${text}`;
    }
  }
  if (actor && (actorKey === 'user' || actorKey === 'scheduler')) text += ` by ${actor}`;

  const details: string[] = [];
  const reason = str(p.reason);
  if (reason && reason !== 'auto_approved') details.push(reason.replace(/_/g, ' ')); // the text already says it
  if (typeof p.score === 'number') {
    details.push(`review score ${p.score}/10${typeof p.below === 'number' ? ` (auto-approve below ${p.below})` : ''}`);
  }
  const sha = str(p.sha) ?? str(p.mergeSha);
  if (sha) details.push(sha.slice(0, 10));
  const message = str(p.message) ?? str(p.error) ?? str(p.text) ?? str(p.note);
  if (message) details.push(message);
  const fields = p.fields;
  if (Array.isArray(fields) && fields.length) details.push(`changed ${fields.join(', ')}`);
  const files = p.files;
  if (Array.isArray(files) && files.length) details.push(`conflicts in ${files.slice(0, 3).join(', ')}${files.length > 3 ? '…' : ''}`);
  const planKey = str(p.planKey);
  if (planKey) details.push(planKey);

  let tone: DescribedEvent['tone'] = 'default';
  if (to === 'failed' || e.type === 'illegal_transition' || e.type === 'plan_failed' || (approved && to === 'human_review'))
    tone = 'bad';
  else if (to === 'done' || eventName === 'review.pass') tone = 'good';
  else if (eventName === 'review.changes' || e.type === 'attention_set' || e.type === 'auto_approve_failed') tone = 'warn';

  return { text, detail: details.length ? details.join(' · ') : null, tone };
}
