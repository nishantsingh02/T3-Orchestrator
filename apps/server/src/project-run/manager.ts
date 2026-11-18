// Runs projects for "Run project": one run per target (a board's root checkout, or a task's worktree).
// A run has one or more parts (programs side by side, e.g. a frontend and its API). Each part runs
// its setup steps to completion, then the program itself. Output is kept, streamed over SSE, and the
// first part's output is scanned for the local URL to hand out. A command that exits but leaves the
// app answering (it started Docker containers, say) keeps its run live in the background until Stop
// runs the project's stop command.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import {
  isLiveRunStatus,
  recipeParts,
  type ProjectRunStatus,
  type ProjectRunView,
  type RunLogView,
  type RunPart,
  type RunRecipe,
} from '@t3-orchestra/shared';
import type { Bus } from '../bus.ts';
import { childLog } from '../log.ts';
import { errorMessage, newId, nowIso } from '../util.ts';
import { detectRecipes, q, type DetectEnv } from './detect.ts';
import { serveStatic } from './staticServer.ts';
import {
  childEnv,
  descendants,
  extractUrl,
  freePort,
  isAlive,
  killTree,
  killTreeSync,
  onPath,
  openConsoleWindow,
  openMacTerminal,
  processStartTimes,
  processTable,
  stripAnsi,
  type ProcInfo,
} from './system.ts';

const log = childLog('project-run');

const MAX_LOG_CHARS = 200_000;
const FLUSH_MS = 120;
const READY_TIMEOUT_MS = 180_000;
const STOP_WAIT_MS = 5000;
/** A pid in the orphan file is ours if the process started this close to when we spawned it. */
const START_TIME_SLACK_MS = 15_000;
/** How often the process trees of running programs are recorded (see `trackTrees`). */
const TRACK_EVERY_MS = 20_000;
/** After a command exits cleanly, how long its URL gets to answer before the run counts as finished. */
const BACKGROUND_GRACE_MS = 10_000;
/** A background app that fails this many checks in a row was stopped some other way. */
const BACKGROUND_MISSES = 3;
const BACKGROUND_LOG_CHARS = 20_000;
/** A stop command still running after this is killed. */
const STOP_COMMAND_TIMEOUT_MS = 120_000;

export interface RunTarget {
  boardId: string;
  taskId: string | null;
  dir: string;
}

interface Outcome {
  ok: boolean;
  error: string | null;
  code: number | null;
}
const OK: Outcome = { ok: true, error: null, code: 0 };
const STOPPED: Outcome = { ok: true, error: null, code: null };

interface LivePart {
  index: number;
  part: RunPart;
  /** `[label] ` before each output line when the run has several parts. */
  prefix: string;
  /** Running the part's last step (the program itself). */
  onLastStep: boolean;
  child: ChildProcess | null;
  childStartedAt: number;
  /** The child and everything under it, as last seen (`trackTrees`). */
  tree: ProcInfo[];
  /** A console window we opened; not our child, so it is polled until it closes. */
  windowPid: number | null;
  partialLine: string;
  /** Ends a part that has no process to kill (the built-in static server). */
  release: (() => void) | null;
  exited: Promise<Outcome>;
  done: boolean;
}

interface LiveRun {
  view: ProjectRunView;
  parts: LivePart[];
  /** The tail of the output; `total` counts every character ever written. */
  log: string;
  total: number;
  /** Written but not yet pushed over SSE. */
  pending: string;
  /** Dev servers print a "Local:" URL first and "Network:" ones after; a Local one wins. */
  urlFromLocal: boolean;
  flushTimer: NodeJS.Timeout | null;
  timers: Set<NodeJS.Timeout>;
  stopping: boolean;
}

const targetKey = (boardId: string, taskId: string | null) => `${boardId}:${taskId ?? ''}`;

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const clean = (raw: string) => stripAnsi(raw).replace(/\r+\n/g, '\n').replace(/\r/g, '\n');

/** Something answers at `url` (any status code). */
async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    void res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

interface SavedBackgroundRun {
  view: ProjectRunView;
  log: string;
  tree: ProcInfo[];
}

export class ProjectRunManager {
  private readonly byTarget = new Map<string, LiveRun>();
  private readonly byId = new Map<string, LiveRun>();
  private readonly orphanFile: string;
  private readonly backgroundFile: string;
  private readonly backgroundPollMs: number;
  private trackTimer: NodeJS.Timeout | null = null;
  private trackDue = 0;
  private tracking = false;

  constructor(private readonly o: { bus: Bus; dataDir: string; backgroundPollMs?: number }) {
    this.orphanFile = path.join(o.dataDir, 'project-runs.json');
    this.backgroundFile = path.join(o.dataDir, 'background-runs.json');
    this.backgroundPollMs = o.backgroundPollMs ?? 5000;
  }

  /** Build output for `dir` goes here, outside the repo. */
  buildDir(dir: string): string {
    const norm = path.resolve(dir);
    const id = createHash('sha1')
      .update(process.platform === 'win32' ? norm.toLowerCase() : norm)
      .digest('hex')
      .slice(0, 12);
    return path.join(this.o.dataDir, 'run-builds', id);
  }

  detect(dir: string): Promise<RunRecipe[]> {
    const env = childEnv();
    const detectEnv: DetectEnv = {
      platform: process.platform,
      has: async (cmd) => onPath(cmd, env),
      port: freePort,
      buildDir: this.buildDir(dir),
    };
    return detectRecipes(dir, detectEnv);
  }

  current(boardId: string, taskId: string | null): ProjectRunView | null {
    const run = this.byTarget.get(targetKey(boardId, taskId));
    return run ? { ...run.view } : null;
  }

  get(id: string): ProjectRunView | null {
    const run = this.byId.get(id);
    return run ? { ...run.view } : null;
  }

  list(): ProjectRunView[] {
    return [...this.byTarget.values()].map((r) => ({ ...r.view }));
  }

  log(id: string): RunLogView | null {
    const run = this.byId.get(id);
    return run ? { text: run.log, end: run.total } : null;
  }

  /** Starts `recipe` for the target, stopping whatever ran there before. */
  async start(target: RunTarget, recipe: RunRecipe): Promise<ProjectRunView> {
    const key = targetKey(target.boardId, target.taskId);
    const prev = this.byTarget.get(key);
    if (prev) {
      await this.halt(prev, 'stopped', null);
      this.byId.delete(prev.view.id);
    }
    const run = this.newRun({
      id: newId(),
      boardId: target.boardId,
      taskId: target.taskId,
      dir: target.dir,
      recipe,
      status: 'starting',
      step: 0,
      url: null,
      pid: null,
      exitCode: null,
      error: null,
      fixTaskId: null,
      background: false,
      stopping: false,
      startedAt: nowIso(),
      endedAt: null,
    });
    this.byTarget.set(key, run);
    this.byId.set(run.view.id, run);
    this.emit(run);
    log.info({ id: run.view.id, dir: target.dir, recipe: recipe.id }, 'project run starting');
    void this.execute(run).catch((err) => this.finish(run, 'failed', errorMessage(err)));
    return { ...run.view };
  }

  private newRun(view: ProjectRunView): LiveRun {
    const parts = recipeParts(view.recipe);
    return {
      view,
      parts: parts.map((part, index) => this.newPart(part, index, parts.length > 1 ? `[${part.label}] ` : '')),
      log: '',
      total: 0,
      pending: '',
      urlFromLocal: false,
      flushTimer: null,
      timers: new Set(),
      stopping: false,
    };
  }

  private newPart(part: RunPart, index: number, prefix: string): LivePart {
    return {
      index,
      part,
      prefix,
      onLastStep: false,
      child: null,
      childStartedAt: 0,
      tree: [],
      windowPid: null,
      partialLine: '',
      release: null,
      exited: Promise.resolve(OK),
      done: false,
    };
  }

  /** Records that an agent is fixing this run's failure in `taskId`. */
  setFixTask(id: string, taskId: string): ProjectRunView | null {
    const run = this.byId.get(id);
    if (!run) return null;
    this.update(run, { fixTaskId: taskId });
    return { ...run.view };
  }

  async stop(id: string): Promise<ProjectRunView | null> {
    const run = this.byId.get(id);
    if (!run) return null;
    await this.halt(run, 'stopped', null);
    return { ...run.view };
  }

  /**
   * On shutdown: programs we run die with us. Console windows belong to the user and stay open, and
   * an app running in the background (`view.background`) outlives us too: `restoreBackground` finds it again.
   */
  stopAll(): void {
    if (this.trackTimer) clearTimeout(this.trackTimer);
    this.trackTimer = null;
    for (const run of this.byTarget.values()) {
      for (const t of run.timers) clearTimeout(t);
      run.timers.clear();
      if (!isLiveRunStatus(run.view.status) || run.view.background) continue;
      run.stopping = true;
      for (const lp of run.parts) {
        if (lp.child?.pid) killTreeSync(lp.child.pid);
        for (const p of lp.tree) if (isAlive(p.pid)) killTreeSync(p.pid); // cut off from the root (see trackTrees)
        lp.release?.();
      }
    }
    fs.rmSync(this.orphanFile, { force: true });
  }

  /** Kills programs left running by a T3 Orchestra process that died without stopping them (e.g. a `node --watch` restart). */
  cleanupOrphans(): void {
    let entries: Array<{ pid: number; startedAt: number }> = [];
    try {
      entries = JSON.parse(fs.readFileSync(this.orphanFile, 'utf8'));
    } catch {
      return;
    }
    fs.rmSync(this.orphanFile, { force: true });
    const alive = entries.filter((e) => Number.isInteger(e.pid) && e.pid > 0 && isAlive(e.pid));
    if (alive.length === 0) return;
    const started = processStartTimes(alive.map((e) => e.pid));
    for (const e of alive) {
      const t = started.get(e.pid);
      if (t === undefined || Math.abs(t - e.startedAt) > START_TIME_SLACK_MS) continue; // the pid was reused
      log.info({ pid: e.pid }, 'stopping a project run left over from a previous server');
      killTreeSync(e.pid);
    }
  }

  /** Brings back the background runs of a previous server: their apps kept running, and Stop should still reach them. */
  restoreBackground(): void {
    let saved: SavedBackgroundRun[] = [];
    try {
      saved = JSON.parse(fs.readFileSync(this.backgroundFile, 'utf8'));
    } catch {
      return;
    }
    for (const s of Array.isArray(saved) ? saved : []) {
      if (!s?.view?.url || !s.view.recipe || !fs.existsSync(s.view.dir)) continue;
      const key = targetKey(s.view.boardId, s.view.taskId);
      if (this.byTarget.has(key)) continue;
      const run = this.newRun({ ...s.view, status: 'ready', background: true, stopping: false });
      for (const lp of run.parts) {
        lp.done = true;
        lp.onLastStep = true;
      }
      run.parts[0]!.tree = Array.isArray(s.tree) ? s.tree : [];
      run.log = `${s.log ?? ''}\n(T3 Orchestra restarted; the app kept running.)\n`;
      run.total = run.log.length;
      this.byTarget.set(key, run);
      this.byId.set(run.view.id, run);
      log.info({ id: run.view.id, url: run.view.url }, 'background project run restored');
      this.watchBackground(run);
    }
    this.saveBackground();
  }

  // ---- running -----------------------------------------------------------------------

  private async execute(run: LiveRun): Promise<void> {
    for (const lp of run.parts) {
      const cwd = path.resolve(run.view.dir, lp.part.cwd || '.');
      if (!fs.existsSync(cwd)) return this.finish(run, 'failed', `Folder not found: ${cwd}`);
      for (const s of lp.part.steps) {
        const out = s.candidates?.[0];
        if (out && path.isAbsolute(out)) fs.mkdirSync(path.dirname(out), { recursive: true });
      }
    }
    for (const lp of run.parts) {
      lp.exited = this.executePart(run, lp).catch((err): Outcome => ({ ok: false, error: errorMessage(err), code: null }));
    }
    await Promise.all(run.parts.map(async (lp) => this.partEnded(run, lp, await lp.exited)));
  }

  private partEnded(run: LiveRun, lp: LivePart, outcome: Outcome): Promise<void> | void {
    lp.done = true;
    if (lp.partialLine) {
      this.write(run, `${lp.prefix}${lp.partialLine}\n`);
      lp.partialLine = '';
    }
    if (run.stopping || !isLiveRunStatus(run.view.status)) return;
    const name = run.parts.length > 1 ? `${lp.part.label}: ` : '';
    if (!outcome.ok) return this.halt(run, 'failed', `${name}${outcome.error}`, outcome.code);
    if (run.parts.some((p) => !p.done)) {
      this.write(run, `${lp.prefix}exited.\n`);
      return;
    }
    return this.ended(run, outcome.code);
  }

  /**
   * Every part exited cleanly. A launcher (say, a script that runs `docker compose up --detach`) leaves
   * the app running: if its URL still answers and there is a way to stop it, the run stays live.
   */
  private async ended(run: LiveRun, code: number | null): Promise<void> {
    const { url, recipe } = run.view;
    if (url && !(recipe.mode === 'terminal' && run.parts.length === 1)) {
      const left = await this.aliveTracked(run.parts.flatMap((lp) => lp.tree));
      const stoppable = Boolean(recipe.stop) || left.length > 0;
      const deadline = Date.now() + (stoppable ? BACKGROUND_GRACE_MS : 0);
      let up = await answers(url);
      while (!up && !run.stopping && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 700));
        up = await answers(url);
      }
      if (run.stopping || !isLiveRunStatus(run.view.status)) return;
      if (up && stoppable) return this.toBackground(run, code);
      if (up) this.write(run, `\nThe command finished, but something still answers at ${url}. T3 Orchestra doesn't know how to stop it.\n`);
    }
    this.finish(run, 'exited', null, code);
  }

  private toBackground(run: LiveRun, code: number | null): void {
    const { stop } = run.view.recipe;
    this.write(run, `\nThe command finished; the app keeps running in the background. ${stop ? `Stop runs \`${stop}\`.` : 'Stop ends what it left running.'}\n`);
    this.flush(run);
    this.update(run, { status: 'ready', background: true, exitCode: code, pid: null });
    this.saveBackground();
    this.watchBackground(run);
    log.info({ id: run.view.id, url: run.view.url }, 'project run continues in the background');
  }

  /** Checks a background app now and then; once it stops answering, someone stopped it elsewhere. */
  private watchBackground(run: LiveRun, misses = 0): void {
    this.later(
      run,
      async () => {
        const url = run.view.url;
        if (!url || run.stopping || !isLiveRunStatus(run.view.status)) return;
        const up = await answers(url);
        if (run.stopping || !isLiveRunStatus(run.view.status)) return;
        if (up || misses + 1 < BACKGROUND_MISSES) return this.watchBackground(run, up ? 0 : misses + 1);
        this.write(run, `\nIt no longer answers at ${url}; it was stopped outside T3 Orchestra.\n`);
        this.finish(run, 'exited', null, run.view.exitCode);
      },
      this.backgroundPollMs,
    );
  }

  private async executePart(run: LiveRun, lp: LivePart): Promise<Outcome> {
    const { steps } = lp.part;
    const cwd = path.resolve(run.view.dir, lp.part.cwd || '.');
    const primary = lp.index === 0;
    for (const [i, s] of steps.entries()) {
      if (run.stopping) return STOPPED;
      const last = i === steps.length - 1;
      lp.onLastStep = last;
      if (primary) this.update(run, { step: i, status: last ? 'running' : 'starting' });

      if (s.staticDir) return this.staticPart(run, lp, path.resolve(cwd, s.staticDir));

      let command = s.command;
      if (s.candidates) {
        const found = s.candidates.find(isFile);
        if (!found) return { ok: false, error: `${s.label}: nothing was built at ${s.candidates[0]}.`, code: null };
        command = q(found);
      }
      this.write(run, `${run.total > 0 && !lp.prefix ? '\n' : ''}${lp.prefix}$ ${command}\n`);

      if (last && run.view.recipe.mode === 'terminal' && run.parts.length === 1) {
        if (process.platform === 'win32') return this.windowPart(run, lp, command, cwd);
        if (process.platform === 'darwin') {
          await openMacTerminal(command, cwd);
          this.write(run, "Opened in Terminal. T3 Orchestra can't follow or stop it there.\n");
          return OK;
        }
        this.write(run, 'No console-window support on this OS; running it here instead (no keyboard input).\n');
      }
      if (last && primary && lp.part.url) this.setUrl(run, lp.part.url, true);

      const code = await this.spawnStep(run, lp, command, cwd);
      if (run.stopping) return STOPPED;
      if (code !== 0) {
        const error = last ? `Exited with code ${code ?? '?'}.` : `${s.label} failed${code === null ? '' : ` (exit code ${code})`}.`;
        return { ok: false, error, code };
      }
    }
    return OK;
  }

  private spawnStep(run: LiveRun, lp: LivePart, command: string, cwd: string): Promise<number | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (code: number | null) => {
        if (settled) return;
        settled = true;
        lp.child = null;
        if (lp.index === 0) this.update(run, { pid: null });
        this.saveOrphans();
        resolve(code);
      };
      let child: ChildProcess;
      try {
        child = spawn(command, {
          cwd,
          shell: true,
          env: childEnv(),
          windowsHide: true,
          // POSIX: its own process group, so Stop reaches the shell's children too.
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        this.write(run, `${lp.prefix}${errorMessage(err)}\n`);
        resolve(null);
        return;
      }
      lp.child = child;
      lp.childStartedAt = Date.now();
      lp.tree = [];
      if (lp.index === 0) this.update(run, { pid: child.pid ?? null });
      this.saveOrphans();
      this.scheduleTrack(3000);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => this.output(run, lp, d));
      child.stderr?.on('data', (d: string) => this.output(run, lp, d));
      child.stdin?.on('error', () => undefined); // EPIPE once the program closes its stdin
      child.once('error', (err) => {
        this.write(run, `${lp.prefix}${err.message}\n`);
        done(null);
      });
      child.once('close', (code) => done(code));
    });
  }

  private async windowPart(run: LiveRun, lp: LivePart, command: string, cwd: string): Promise<Outcome> {
    const pid = await openConsoleWindow({ command, cwd, title: `${run.view.recipe.label} - T3 Orchestra`, env: childEnv() });
    if (run.stopping) {
      await killTree(pid); // Stop was pressed while the window was opening
      return STOPPED;
    }
    lp.windowPid = pid;
    this.update(run, { pid });
    this.write(run, 'Opened in a console window.\n');
    return new Promise((resolve) => {
      const poll = () => {
        if (isAlive(pid)) return this.later(run, poll, 1500);
        lp.windowPid = null;
        resolve(OK);
      };
      this.later(run, poll, 1500);
    });
  }

  private async staticPart(run: LiveRun, lp: LivePart, dir: string): Promise<Outcome> {
    const wanted = Number(new URL(lp.part.url ?? 'http://127.0.0.1/').port) || 8080;
    const onLog = (line: string) => this.write(run, `${lp.prefix}${line}\n`);
    let server: http.Server;
    try {
      server = await serveStatic(dir, wanted, onLog);
    } catch {
      server = await serveStatic(dir, await freePort(wanted + 1), onLog); // taken since detection
    }
    if (run.stopping) {
      server.close();
      return STOPPED;
    }
    const addr = server.address();
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : wanted}/`;
    this.write(run, `${lp.prefix}Serving ${dir} at ${url}\n`);
    if (lp.index === 0) this.update(run, { url, status: 'ready' });
    return new Promise((resolve) => {
      lp.release = () => {
        lp.release = null;
        server.close();
        resolve(STOPPED);
      };
    });
  }

  /**
   * Stops every part, waits for them to exit (briefly), then records the end. On Stop (not a failure),
   * the project's stop command then ends what killing doesn't reach: containers, daemons.
   */
  private async halt(run: LiveRun, status: ProjectRunStatus, error: string | null, code: number | null = null): Promise<void> {
    if (run.stopping || !isLiveRunStatus(run.view.status)) return;
    run.stopping = true;
    this.update(run, { stopping: true });
    await Promise.all(
      run.parts.map((lp) => {
        lp.release?.();
        const pid = lp.child?.pid ?? lp.windowPid;
        return pid ? killTree(pid) : undefined;
      }),
    );
    await Promise.race([Promise.all(run.parts.map((lp) => lp.exited)), new Promise((r) => setTimeout(r, STOP_WAIT_MS))]);
    await this.killStragglers(run.parts.flatMap((lp) => lp.tree));
    // Before the program step nothing was started that needs it.
    if (status === 'stopped' && run.view.recipe.stop && run.parts.some((lp) => lp.onLastStep)) error = await this.runStop(run);
    this.finish(run, status, error, code);
  }

  /** Runs the recipe's stop command; returns what to show if it failed. */
  private async runStop(run: LiveRun): Promise<string | null> {
    const command = run.view.recipe.stop!;
    // Not one of the run's parts: its pid and output are not the program's.
    const lp = this.newPart(recipeParts(run.view.recipe)[0]!, -1, '');
    this.write(run, `\n$ ${command}\n`);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (lp.child?.pid) void killTree(lp.child.pid);
    }, STOP_COMMAND_TIMEOUT_MS);
    const code = await this.spawnStep(run, lp, command, path.resolve(run.view.dir, run.view.recipe.cwd || '.'));
    clearTimeout(timer);
    if (lp.partialLine) this.write(run, `${lp.partialLine}\n`);
    if (timedOut) return `\`${command}\` didn't finish within ${STOP_COMMAND_TIMEOUT_MS / 1000} seconds; the app may still be running.`;
    if (code === 0) return null;
    return `\`${command}\` failed${code === null ? '' : ` (exit code ${code})`}; the app may still be running.`;
  }

  /** Recorded processes still running as themselves (not a reused pid). */
  private async aliveTracked(tracked: ProcInfo[]): Promise<ProcInfo[]> {
    const alive = tracked.filter((p) => isAlive(p.pid));
    if (alive.length === 0) return [];
    const now = await processTable();
    return alive.filter((p) => {
      const row = now.find((r) => r.pid === p.pid);
      return row !== undefined && Math.abs(row.startedAt - p.startedAt) < 2000;
    });
  }

  /** Recorded processes still alive after their root's tree was killed: their parent chain broke. */
  private async killStragglers(tracked: ProcInfo[]): Promise<void> {
    for (const p of await this.aliveTracked(tracked)) await killTree(p.pid);
  }

  private finish(run: LiveRun, status: ProjectRunStatus, error: string | null, exitCode: number | null = null): void {
    if (!isLiveRunStatus(run.view.status)) return;
    const background = run.view.background;
    for (const t of run.timers) clearTimeout(t);
    run.timers.clear();
    for (const lp of run.parts) lp.release?.();
    if (error) this.write(run, `\n${error}\n`);
    this.flush(run);
    this.update(run, { status, error, exitCode, pid: null, endedAt: nowIso(), background: false, stopping: false });
    this.saveOrphans();
    if (background) this.saveBackground();
    log.info({ id: run.view.id, status, exitCode }, 'project run ended');
  }

  // ---- output and URL -------------------------------------------------------------------

  /** Program output for one part: prefixed per line when there are several parts, scanned for a URL. */
  private output(run: LiveRun, lp: LivePart, raw: string): void {
    const text = clean(raw);
    if (!text) return;
    const lines = (lp.partialLine + text).split('\n');
    lp.partialLine = lines.pop() ?? '';
    if (lp.partialLine.length > 4096) {
      lines.push(lp.partialLine);
      lp.partialLine = '';
    }
    if (!lp.prefix) this.write(run, text);
    else if (lines.length) this.write(run, lines.map((l) => `${lp.prefix}${l}\n`).join(''));

    if (lp.index !== 0 || !lp.onLastStep) return;
    for (const line of lines) {
      const url = extractUrl(line);
      if (!url) continue;
      const local = /\blocal\b/i.test(line);
      if (run.view.url && (run.urlFromLocal || !local)) continue;
      this.setUrl(run, url, local);
    }
  }

  private write(run: LiveRun, text: string): void {
    if (!text) return;
    run.log += text;
    run.total += text.length;
    run.pending += text;
    if (run.log.length > MAX_LOG_CHARS) {
      const from = run.log.length - Math.floor(MAX_LOG_CHARS * 0.8);
      const nl = run.log.indexOf('\n', from);
      run.log = run.log.slice(nl >= 0 ? nl + 1 : from);
    }
    if (run.pending.length > MAX_LOG_CHARS) run.pending = run.pending.slice(-MAX_LOG_CHARS);
    run.flushTimer ??= setTimeout(() => this.flush(run), FLUSH_MS);
  }

  private flush(run: LiveRun): void {
    if (run.flushTimer) clearTimeout(run.flushTimer);
    run.flushTimer = null;
    if (!run.pending || !this.byId.has(run.view.id)) return;
    this.o.bus.emit('project_run_log', { id: run.view.id, start: run.total - run.pending.length, text: run.pending });
    run.pending = '';
  }

  private setUrl(run: LiveRun, url: string, local: boolean): void {
    run.urlFromLocal = local;
    this.update(run, { url });
    const started = Date.now();
    // "ready" once something answers at the URL (any status code).
    const attempt = async () => {
      if (!this.byId.has(run.view.id) || run.view.url !== url || run.view.status !== 'running') return;
      if (await answers(url)) {
        if (run.view.url === url && run.view.status === 'running') {
          this.update(run, { status: 'ready' });
          this.scheduleTrack(300); // the server is up: its processes exist now
        }
        return;
      }
      if (Date.now() - started < READY_TIMEOUT_MS) this.later(run, attempt, 700);
    };
    this.later(run, attempt, 150);
  }

  // ---- plumbing ------------------------------------------------------------------------

  private later(run: LiveRun, fn: () => void | Promise<void>, ms: number): void {
    const t = setTimeout(() => {
      run.timers.delete(t);
      void fn();
    }, ms);
    run.timers.add(t);
  }

  private update(run: LiveRun, patch: Partial<ProjectRunView>): void {
    Object.assign(run.view, patch);
    if (this.byId.has(run.view.id)) this.emit(run);
  }

  private emit(run: LiveRun): void {
    this.o.bus.emit('project_run', { ...run.view });
  }

  private liveParts(): LivePart[] {
    return [...this.byTarget.values()].filter((r) => isLiveRunStatus(r.view.status) && !r.stopping).flatMap((r) => r.parts);
  }

  private scheduleTrack(ms: number): void {
    const due = Date.now() + ms;
    if (this.trackTimer && this.trackDue <= due) return;
    if (this.trackTimer) clearTimeout(this.trackTimer);
    this.trackDue = due;
    this.trackTimer = setTimeout(() => {
      this.trackTimer = null;
      void this.trackTrees();
    }, ms);
    this.trackTimer.unref();
  }

  /**
   * Records every process under each running program. When T3 Orchestra dies hard (a crash, or a
   * `node --watch` restart, which kills it outright on Windows), the shell we started and npm often
   * exit on the broken output pipe while the dev server lives on with no parent; killing the
   * recorded pids is the only way to reach it then.
   */
  private async trackTrees(): Promise<void> {
    if (this.tracking || !this.liveParts().some((lp) => lp.child?.pid)) return;
    this.tracking = true;
    try {
      const table = await processTable();
      for (const lp of this.liveParts()) {
        const pid = lp.child?.pid;
        if (pid) lp.tree = descendants(table, pid);
      }
      this.saveOrphans();
    } finally {
      this.tracking = false;
    }
    if (this.liveParts().some((lp) => lp.child?.pid)) this.scheduleTrack(TRACK_EVERY_MS);
  }

  /** Pids of the background programs now running, so a restarted server can stop them. */
  private saveOrphans(): void {
    const entries = this.liveParts()
      .filter((lp) => lp.child?.pid)
      .flatMap((lp) => (lp.tree.length ? lp.tree : [{ pid: lp.child!.pid!, startedAt: lp.childStartedAt }]))
      .map((p) => ({ pid: p.pid, startedAt: p.startedAt }));
    try {
      if (entries.length === 0) fs.rmSync(this.orphanFile, { force: true });
      else {
        fs.mkdirSync(path.dirname(this.orphanFile), { recursive: true });
        fs.writeFileSync(this.orphanFile, JSON.stringify(entries));
      }
    } catch (err) {
      log.warn({ err }, 'could not write the project-run pid file');
    }
  }

  /** The runs whose apps live on in the background, for `restoreBackground` after a restart. */
  private saveBackground(): void {
    const entries: SavedBackgroundRun[] = [...this.byTarget.values()]
      .filter((r) => r.view.background && isLiveRunStatus(r.view.status))
      .map((r) => ({ view: r.view, log: r.log.slice(-BACKGROUND_LOG_CHARS), tree: r.parts.flatMap((lp) => lp.tree) }));
    try {
      if (entries.length === 0) fs.rmSync(this.backgroundFile, { force: true });
      else {
        fs.mkdirSync(path.dirname(this.backgroundFile), { recursive: true });
        fs.writeFileSync(this.backgroundFile, JSON.stringify(entries));
      }
    } catch (err) {
      log.warn({ err }, 'could not write the background-run file');
    }
  }
}
