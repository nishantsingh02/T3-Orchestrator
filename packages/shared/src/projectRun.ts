// "Run project": how to start a board's repo (or a task's worktree) and what the run looks like.
import { z } from 'zod';
import type { TaskView } from './views.ts';

/** `background`: T3 Orchestra keeps the process and shows its output. `terminal`: it opens in its own console window. */
export const RUN_MODES = ['background', 'terminal'] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** What the user gets: a URL to open, a window that opens by itself, or a console program. */
export const PROJECT_KINDS = ['web', 'app', 'console'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_RUN_STATUSES = ['starting', 'running', 'ready', 'exited', 'failed', 'stopped'] as const;
export type ProjectRunStatus = (typeof PROJECT_RUN_STATUSES)[number];

export const isLiveRunStatus = (s: ProjectRunStatus) => s === 'starting' || s === 'running' || s === 'ready';

/** A board's own run command, used instead of detection. `cwd` is relative to the project root. */
export const RunConfig = z.object({
  command: z.string().trim().min(1).max(2000),
  mode: z.enum(RUN_MODES).default('background'),
  cwd: z.string().trim().max(500).default(''),
});
export type RunConfig = z.infer<typeof RunConfig>;

export interface RunStep {
  label: string;
  /** Shell command line. For a `staticDir` step it is only shown. */
  command: string;
  /** Run the first of these files that exists (a build output) instead of `command`. */
  candidates?: string[];
  /** Serve this directory with T3 Orchestra's built-in static server. */
  staticDir?: string;
}

/** One program of a recipe that starts several side by side (e.g. a frontend and its API). */
export interface RunPart {
  label: string;
  cwd: string;
  steps: RunStep[];
  url: string | null;
  kind: ProjectKind;
}

export interface RunRecipe {
  /** Stable within one detection, e.g. `node:apps/web:dev`; `custom` for the board's own command. */
  id: string;
  label: string;
  kind: ProjectKind;
  mode: RunMode;
  /** Relative to the run's root directory; '' = the root. */
  cwd: string;
  /** Setup steps run to completion first; the last step is the program itself. Empty when `parts` is set. */
  steps: RunStep[];
  /** Programs started side by side; the first one's URL is the one handed out. */
  parts?: RunPart[];
  /** Why detection picked this, in a few words. */
  reason: string;
  /** Known up front (we chose the port); otherwise read from the output. */
  url: string | null;
  source: 'detected' | 'custom';
  /** Something that will probably stop it from working (missing tool, missing dependencies). */
  warning: string | null;
  /**
   * The project's own way to stop what it starts (a `stop` script, `docker compose down`), run in `cwd`
   * on Stop. Killing the processes doesn't end containers or daemons a launcher left behind.
   */
  stop?: string;
}

/** A recipe's programs: its parts, or the recipe itself as the only one. */
export function recipeParts(r: RunRecipe): RunPart[] {
  return r.parts?.length ? r.parts : [{ label: r.label, cwd: r.cwd, steps: r.steps, url: r.url, kind: r.kind }];
}

export interface RunInfoView {
  /** Absolute directory the run starts in (board root checkout or task worktree). */
  dir: string;
  recipes: RunRecipe[];
  config: RunConfig | null;
  run: ProjectRunView | null;
}

export interface ProjectRunView {
  id: string;
  boardId: string;
  taskId: string | null;
  dir: string;
  recipe: RunRecipe;
  status: ProjectRunStatus;
  /** Index of the step running now (or the one that failed), in the steps of the first part. */
  step: number;
  url: string | null;
  pid: number | null;
  exitCode: number | null;
  error: string | null;
  /** The task an agent is fixing this failure in ("Fix with AI"). */
  fixTaskId: string | null;
  /**
   * The command finished but the app still answers at `url` (e.g. it started Docker containers), so the
   * run stays live until Stop runs the recipe's `stop` command, or the app stops answering.
   */
  background: boolean;
  /** Stop was pressed and is still working (the stop command can take a while). */
  stopping: boolean;
  startedAt: string;
  endedAt: string | null;
}

export const StartRunBody = z.object({
  recipeId: z.string().optional(),
  /** A one-off or saved command instead of a detected recipe. */
  config: RunConfig.optional(),
  /** Store `config` as the board's run command. */
  save: z.boolean().optional(),
});
export type StartRunBody = z.infer<typeof StartRunBody>;

export const FixRunBody = z.object({
  /** Extra hints for the agent. */
  note: z.string().trim().max(2000).optional(),
});
export type FixRunBody = z.infer<typeof FixRunBody>;

export interface FixRunResponse {
  run: ProjectRunView;
  task: TaskView;
  /** A new task was made (board runs, or the task is done); otherwise the task's own agent got the error. */
  created: boolean;
  /** A new task that could not be started (e.g. T3 is down) waits in the Backlog. */
  startError: string | null;
}

export interface RunLogView {
  text: string;
  /** Offset of the end of `text` in the run's whole output; log events carry their start offset. */
  end: number;
}
