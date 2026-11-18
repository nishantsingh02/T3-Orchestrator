// "Fix with AI" for a failed project run. A task's worktree run goes back to that task's own agent;
// a board run (or a task that is already done) becomes a new task that is started at once, so the
// fix goes through the usual worktree → AI review → your review → merge.
import { CreateTaskBody, recipeParts, type ProjectRunView } from '@t3-orchestra/shared';
import type { TaskRow } from '../db/schema.ts';
import { runAction } from '../engine/actions.ts';
import { AppError, getTaskOrThrow, type EngineContext } from '../engine/context.ts';
import { createTask } from '../engine/tasks.ts';
import { errorMessage } from '../util.ts';
import type { ProjectRunManager } from './manager.ts';

const LOG_LINES = 80;
const LOG_CHARS = 6000;

/** The end of the output, small enough for a prompt. */
export function logTail(text: string): string {
  const lines = text.trimEnd().split('\n').slice(-LOG_LINES).join('\n');
  return lines.length > LOG_CHARS ? `…${lines.slice(-LOG_CHARS)}` : lines;
}

const ERROR_LINE = /\b(error|cannot|can't|failed|not found|no such|exception|traceback|refused|denied|missing)\b/i;

/**
 * The line of output that says what went wrong, e.g. "Error: Cannot find module './config.json'":
 * the last one that sounds like an error, in the failed part's output, minus T3 Orchestra's own lines.
 */
export function errorLine(run: ProjectRunView, log: string): string | null {
  const parts = recipeParts(run.recipe);
  const failed = parts.length > 1 ? parts.find((p) => run.error?.startsWith(`${p.label}: `)) : undefined;
  const prefix = failed ? `[${failed.label}] ` : '';
  const lines = log.split('\n').filter((l) => !prefix || l.startsWith(prefix)).map((l) => l.slice(prefix.length).trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l || l.startsWith('$ ') || /^(Exited with code|.+ failed \(exit code \d+\)\.$)/.test(l) || /^at\s/.test(l)) continue;
    if (ERROR_LINE.test(l)) return l.length > 200 ? `${l.slice(0, 199)}…` : l;
  }
  return null;
}

/** What the agent is told: how it ran, what failed, the output. */
export function fixMessage(ctx: EngineContext, run: ProjectRunView, log: string, where: string, note?: string): string {
  return ctx.prompts.render('run-fix', {
    label: run.recipe.label,
    where,
    parts: recipeParts(run.recipe).map((p) => ({
      cwd: p.cwd || '.',
      commands: p.steps.map((s) => `\`${s.command}\``).join(' → '),
    })),
    error: [run.error ?? 'It stopped without saying why.', errorLine(run, log)].filter(Boolean).join(' '),
    log: logTail(log) || '(no output)',
    note: note ?? '',
  });
}

function fixTitle(run: ProjectRunView, log: string): string {
  const what = (errorLine(run, log) ?? run.error ?? run.recipe.label).replace(/\.$/, '');
  const title = `Fix "Run project": ${what}`;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

export async function fixProjectRun(
  ctx: EngineContext,
  runs: ProjectRunManager,
  runId: string,
  note?: string,
): Promise<{ run: ProjectRunView; task: TaskRow; created: boolean; startError: string | null }> {
  const run = runs.get(runId);
  if (!run) throw new AppError('NOT_FOUND', 'run not found', 404);
  if (run.status !== 'failed') throw new AppError('VALIDATION', 'Only a run that failed can be fixed.');
  const log = runs.log(runId)?.text ?? '';

  if (run.taskId) {
    const task = getTaskOrThrow(ctx, run.taskId);
    if (task.stage === 'implementing' || task.stage === 'ai_review') {
      throw new AppError('ILLEGAL_TRANSITION', `#${task.number}'s agent is still working. Try again once it's back in Human Review.`, 409);
    }
    if (task.stage === 'human_review' || task.stage === 'failed') {
      const text = fixMessage(ctx, run, log, "this task's worktree", note);
      const action = task.stage === 'human_review' ? 'request-changes' : 'send-message';
      const sent = await runAction(ctx, task.id, action, { text });
      return { run: runs.setFixTask(runId, task.id) ?? run, task: sent, created: false, startError: null };
    }
    // Done or discarded: its worktree is history, so fix it in a new task like a board run.
  }

  const where = run.taskId ? `the worktree of task #${getTaskOrThrow(ctx, run.taskId).number}` : 'the project root';
  const kind = recipeParts(run.recipe)[0]!.kind;
  const task = createTask(
    ctx,
    run.boardId,
    CreateTaskBody.parse({
      title: fixTitle(run, log),
      description: fixMessage(ctx, run, log, where, note),
      acceptanceCriteria: [
        `T3 Orchestra's "Run project" (${run.recipe.label}) starts without errors`,
        kind === 'web' ? 'The app answers at its local URL' : 'The program starts',
      ],
      category: 'bug',
      complexity: 'small',
      priority: 'high',
    }),
  );
  let startError: string | null = null;
  let started = task;
  try {
    started = await runAction(ctx, task.id, 'start', { force: true });
  } catch (err) {
    startError = errorMessage(err);
  }
  return { run: runs.setFixTask(runId, task.id) ?? run, task: started, created: true, startError };
}
