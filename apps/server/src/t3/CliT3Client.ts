// T3Client backed by the `t3` CLI (spec §4.2, §11.2).
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { childLog } from '../log.ts';
import { sleep } from '../util.ts';
import type { T3ModelCatalogView } from '@t3-orchestra/shared';
import { buildArgs, resolveLauncher, type Launcher } from './launcher.ts';
import {
  normalizeBackgroundWork,
  normalizeDetail,
  normalizeMessages,
  normalizeModelCatalog,
  normalizeProjects,
  normalizeSummary,
  resolveModelSelection,
  T3CliError,
  type BackgroundTask,
  type StartThreadOptions,
  type T3Client,
  type T3Health,
  type T3Project,
  type ThreadCommandResult,
  type ThreadDetail,
  type ThreadMessage,
  type ThreadSummary,
} from './T3Client.ts';
import { dispatchThreadCommands, getServerConfig, getShellSnapshot } from './T3Ws.ts';

const log = childLog('t3cli');

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;
/** Each catalog read mints and revokes a T3 session, so reuse it for a while. */
const CATALOG_TTL_MS = 60_000;
/** The same for the project list (T3's shell snapshot), which changes more often. */
const PROJECTS_TTL_MS = 15_000;

const NOT_FOUND_RE = /no longer available|not found|does not exist|unknown thread/i;
const UNAVAILABLE_RE = /ECONNREFUSED|not running|could not connect|unable to connect|server is not|no server|connect ENOENT/i;

export interface CliT3ClientOptions {
  t3Home: string;
  /** Returns the user's CLI path override (settings.t3CliPath), read at resolve time. */
  cliPath?: () => string | null;
}

export class CliT3Client implements T3Client {
  private launcher: Launcher | null = null;
  private launcherError: string | null = null;
  private catalog: { at: number; value: Promise<T3ModelCatalogView> } | null = null;
  private shell: { at: number; value: Promise<unknown> } | null = null;

  constructor(private readonly opts: CliT3ClientOptions) {}

  /** Current launcher (for the settings page). */
  getLauncher(): Launcher | null {
    this.ensureLauncher();
    return this.launcher;
  }

  resetLauncher(): void {
    this.launcher = null;
    this.launcherError = null;
  }

  private ensureLauncher(): Launcher | null {
    if (this.launcher) return this.launcher;
    try {
      this.launcher = resolveLauncher({ t3Home: this.opts.t3Home, cliPath: this.opts.cliPath?.() });
      this.launcherError = null;
      log.info({ kind: this.launcher.kind, command: this.launcher.command }, 'resolved t3 launcher');
    } catch (err) {
      this.launcherError = err instanceof Error ? err.message : String(err);
    }
    return this.launcher;
  }

  /** Raw CLI call, for spikes and diagnostics. */
  execRaw(args: string[], stdin?: string): Promise<string> {
    return this.exec(args, { stdin, timeoutMs: WRITE_TIMEOUT_MS });
  }

  private async exec(args: string[], o: { stdin?: string; timeoutMs: number }): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const launcher = this.ensureLauncher();
      if (!launcher) {
        throw new T3CliError({ message: this.launcherError ?? 't3 CLI not found', code: 'ENOENT', unavailable: true });
      }
      const argv = buildArgs(launcher, args);
      const started = Date.now();
      const r = await execa(launcher.command, argv, {
        input: o.stdin ?? '',
        env: launcher.env,
        extendEnv: true,
        timeout: o.timeoutMs,
        reject: false,
        windowsHide: true,
        windowsVerbatimArguments: launcher.kind === 'cmd',
        stripFinalNewline: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      const stdout = String(r.stdout ?? '');
      const stderr = String(r.stderr ?? '');
      log.debug({ args: args.slice(0, 3), exitCode: r.exitCode, ms: Date.now() - started }, 't3 exec');

      if (r.code === 'ENOENT' && attempt === 0) {
        // T3 updates can move the exe: re-resolve once.
        this.resetLauncher();
        continue;
      }
      if (r.timedOut) {
        throw new T3CliError({ message: `t3 ${args.slice(0, 2).join(' ')} timed out`, code: 'ETIMEDOUT', stderr, stdout, timedOut: true });
      }
      if (r.failed || r.exitCode !== 0) {
        const text = `${stderr}\n${stdout}`.trim();
        throw new T3CliError({
          message: text.split(/\r?\n/)[0] || r.originalMessage || `t3 exited with ${r.exitCode}`,
          code: r.exitCode ?? r.code ?? 'EFAIL',
          stderr,
          stdout,
          notFound: r.exitCode === 1 && NOT_FOUND_RE.test(text),
          unavailable: r.code === 'ENOENT' || UNAVAILABLE_RE.test(text),
        });
      }
      return stdout;
    }
    throw new T3CliError({ message: 't3 CLI not found', code: 'ENOENT', unavailable: true });
  }

  private parseJson(stdout: string, what: string): unknown {
    try {
      return JSON.parse(stdout);
    } catch {
      // Some commands may log a line before the JSON; take the last JSON-looking chunk.
      const start = stdout.search(/[[{]/);
      if (start >= 0) {
        try {
          return JSON.parse(stdout.slice(start));
        } catch {
          /* fall through */
        }
      }
      throw new T3CliError({ message: `could not parse ${what} JSON output`, code: 'EJSON', stdout });
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (err instanceof T3CliError && (err.notFound || err.code === 'EJSON')) throw err;
        if (i < 2) await sleep(300 * 2 ** i);
      }
    }
    throw lastErr;
  }

  async health(): Promise<T3Health> {
    const launcher = this.ensureLauncher();
    if (!launcher) return { cliFound: false, serverReachable: false, error: this.launcherError ?? 't3 CLI not found' };
    const runtime = readServerRuntime(this.opts.t3Home);
    if (!runtime) {
      return { cliFound: true, serverReachable: false, error: 'T3 Code server runtime info not found (is T3 running?)' };
    }
    if (runtime.pid && !pidAlive(runtime.pid)) {
      return { cliFound: true, serverReachable: false, version: runtime.serverVersion, error: 'T3 Code server process is not running' };
    }
    try {
      const ctrl = AbortSignal.timeout(3000);
      await fetch(runtime.origin, { signal: ctrl, redirect: 'manual' });
      return { cliFound: true, serverReachable: true, version: runtime.serverVersion };
    } catch (err) {
      return {
        cliFound: true,
        serverReachable: false,
        version: runtime.serverVersion,
        error: `T3 Code server at ${runtime.origin} is not reachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async startThread(o: StartThreadOptions): Promise<{ threadId: string; runId?: string; link?: string }> {
    const args = ['thread', 'start', '--json'];
    let message = o.message;
    if (this.ensureLauncher()?.kind === 'cmd') {
      // Titles carry `#` and brackets, which cmd.exe mode refuses: put the title on the first
      // line of the message instead (T3 defaults the title to it).
      message = `${o.title}\n\n${o.message}`;
    } else {
      args.push('--title', o.title);
    }
    const selection = await this.selectionFor(o.provider, o.model);
    if (selection) args.push('--provider', selection.provider, '--model', selection.model);
    if (o.worktree) args.push('--worktree', o.worktree.baseRef, '--branch', o.worktree.branch);
    args.push(o.project, '-');
    const out = await this.exec(args, { stdin: message, timeoutMs: WRITE_TIMEOUT_MS });
    return parseStartOutput(this.parseJson(out, 'thread start'));
  }

  /** `--provider` and `--model` for a start. The CLI takes them only together, so a missing half comes from T3. */
  private async selectionFor(provider: string | null | undefined, model: string | null | undefined) {
    if (provider && model) return { provider, model };
    if (!provider && !model) return null;
    try {
      return resolveModelSelection(await this.modelCatalog(), provider, model);
    } catch (err) {
      if (err instanceof T3CliError) throw err;
      throw new T3CliError({ message: err instanceof Error ? err.message : String(err), code: 'EMODEL' });
    }
  }

  async send(threadId: string, message: string): Promise<{ runId?: string }> {
    const out = await this.exec(['thread', 'send', '--json', threadId, '-'], { stdin: message, timeoutMs: WRITE_TIMEOUT_MS });
    const json = this.parseJson(out, 'thread send') as Record<string, unknown>;
    return { runId: pickRunId(json) };
  }

  async show(threadId: string, o: { messages?: number } = {}): Promise<{ thread: ThreadDetail; messages: ThreadMessage[] }> {
    const args = ['thread', 'show', '--json'];
    if (o.messages !== undefined) args.push('--messages', String(o.messages));
    args.push(threadId);
    return this.withRetry(async () => {
      const json = this.parseJson(await this.exec(args, { timeoutMs: READ_TIMEOUT_MS }), 'thread show') as Record<string, unknown>;
      return { thread: normalizeDetail(json.thread ?? json), messages: normalizeMessages(json.messages) };
    });
  }

  async list(project: string): Promise<ThreadSummary[]> {
    return this.withRetry(async () => {
      const json = this.parseJson(
        await this.exec(['thread', 'list', '--json', '--project', project], { timeoutMs: READ_TIMEOUT_MS }),
        'thread list',
      );
      const arr = Array.isArray(json) ? json : ((json as Record<string, unknown>).threads ?? []);
      return (arr as unknown[]).map(normalizeSummary);
    });
  }

  async addProject(projectPath: string): Promise<void> {
    await this.exec(['project', 'add', projectPath], { timeoutMs: WRITE_TIMEOUT_MS });
  }

  /**
   * The CLI has no settle command, so this uses T3's WebSocket API. Its MCP endpoint is no help: a
   * session issued by `t3 auth session issue` is capped at `approval-required` there and may not
   * touch full-access threads.
   */
  async settleThreads(threadIds: string[]): Promise<ThreadCommandResult[]> {
    if (!threadIds.length) return [];
    return this.withWsSession(['orchestration:read', 'orchestration:operate'], (origin, token) =>
      dispatchThreadCommands({ origin, token, type: 'thread.settle', threadIds }),
    );
  }

  /** From T3's WebSocket API (the CLI cannot list providers), cached for a minute. */
  modelCatalog(): Promise<T3ModelCatalogView> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.value;
    const value = this.withWsSession(['orchestration:read'], async (origin, token) => normalizeModelCatalog(await getServerConfig({ origin, token })));
    const entry = { at: Date.now(), value };
    this.catalog = entry;
    value.catch(() => {
      if (this.catalog === entry) this.catalog = null;
    });
    return value;
  }

  /** From T3's shell snapshot over `/ws` (the CLI has no project list), cached for a few seconds. */
  async listProjects(): Promise<T3Project[]> {
    return normalizeProjects(await this.shellSnapshot(PROJECTS_TTL_MS));
  }

  /** From a fresh shell snapshot (`thread show` has no background work). */
  async backgroundWork(): Promise<Map<string, BackgroundTask[]>> {
    return normalizeBackgroundWork(await this.shellSnapshot(0));
  }

  /** T3's shell snapshot (~2 KB per thread), reused when it is at most `maxAgeMs` old. */
  private shellSnapshot(maxAgeMs: number): Promise<unknown> {
    if (this.shell && Date.now() - this.shell.at <= maxAgeMs) return this.shell.value;
    const value = this.withWsSession(['orchestration:read'], (origin, token) => getShellSnapshot({ origin, token }));
    const entry = { at: Date.now(), value };
    this.shell = entry;
    value.catch(() => {
      if (this.shell === entry) this.shell = null;
    });
    return value;
  }

  /** Runs `fn` against T3's `/ws` with a short-lived session from `t3 auth session issue`, revoked afterwards. */
  private async withWsSession<T>(scopes: string[], fn: (origin: string, token: string) => Promise<T>): Promise<T> {
    const runtime = readServerRuntime(this.opts.t3Home);
    if (!runtime) throw new T3CliError({ message: 'T3 Code server runtime info not found (is T3 running?)', code: 'ENOENT', unavailable: true });
    const out = await this.exec(
      ['auth', 'session', 'issue', ...scopes.flatMap((s) => ['--scope', s]), '--ttl', '5m', '--label', 'T3 Orchestra', '--json'],
      { timeoutMs: WRITE_TIMEOUT_MS },
    );
    // Parsed here rather than with parseJson, whose errors would carry the token in `stdout`.
    let issued: Record<string, unknown> = {};
    try {
      issued = JSON.parse(out.slice(Math.max(0, out.indexOf('{')))) as Record<string, unknown>;
    } catch {
      /* reported below */
    }
    if (typeof issued.token !== 'string') throw new T3CliError({ message: 'auth session issue printed no token', code: 'EJSON' });
    try {
      return await fn(runtime.origin, issued.token);
    } catch (err) {
      throw new T3CliError({ message: err instanceof Error ? err.message : String(err), code: 'EWS', unavailable: true });
    } finally {
      if (typeof issued.sessionId === 'string') {
        await this.exec(['auth', 'session', 'revoke', issued.sessionId], { timeoutMs: READ_TIMEOUT_MS }).catch((err) =>
          log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not revoke a T3 session (it expires in 5 minutes)'),
        );
      }
    }
  }
}

function pickRunId(json: Record<string, unknown> | undefined | null): string | undefined {
  if (!json) return undefined;
  for (const k of ['runId', 'activeRunId', 'latestRunId']) if (typeof json[k] === 'string') return json[k] as string;
  const run = json.run as Record<string, unknown> | undefined;
  if (run && typeof run.runId === 'string') return run.runId;
  if (run && typeof run.id === 'string') return run.id;
  const thread = json.thread as Record<string, unknown> | undefined;
  return thread ? pickRunId(thread) : undefined;
}

export function parseStartOutput(json: unknown): { threadId: string; runId?: string; link?: string } {
  const o = (json ?? {}) as Record<string, unknown>;
  const thread = (o.thread ?? o) as Record<string, unknown>;
  const threadId = (thread.threadId ?? thread.id ?? o.threadId) as string | undefined;
  if (typeof threadId !== 'string') throw new T3CliError({ message: 'thread start output has no threadId', code: 'EJSON', stdout: JSON.stringify(json) });
  const link = (thread.link ?? o.link) as string | undefined;
  return { threadId, runId: pickRunId(o), link: typeof link === 'string' ? link : undefined };
}

export interface ServerRuntime {
  pid?: number;
  origin: string;
  serverVersion?: string;
}

export function readServerRuntime(t3Home: string): ServerRuntime | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(t3Home, 'userdata', 'server-runtime.json'), 'utf8')) as Record<string, unknown>;
    const port = typeof raw.port === 'number' ? raw.port : 3773;
    const origin = typeof raw.origin === 'string' ? raw.origin : `http://127.0.0.1:${port}`;
    return {
      pid: typeof raw.pid === 'number' ? raw.pid : undefined,
      origin,
      serverVersion: typeof raw.serverVersion === 'string' ? raw.serverVersion : undefined,
    };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
