// The T3 Code adapter interface (spec §11.2). The board logic only talks to this.
import type { T3ModelCatalogView, T3ModelView, T3ProviderView } from '@t3-orchestra/shared';
import type { ThreadCommandResult } from './T3Ws.ts';

export type { ThreadCommandResult };

export interface ThreadSummary {
  threadId: string;
  projectId: string | null;
  title: string;
  link: string | null;
  status: string;
  latestRunId: string | null;
  providerInstanceId: string | null;
  model: string | null;
  runtimeMode: string | null;
  interactionMode: string | null;
  linkedPullRequest: unknown;
  pullRequests: unknown[];
  itemCount: number;
  /** Present on `show`, missing on `list`. */
  runCount?: number;
  /** Settled in T3's sidebar (missing on T3 versions without settling). */
  settled?: boolean;
  /** Set on sub-agent threads: the thread that started them. */
  parentThreadId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A project T3 Code knows, with its thread count. */
export interface T3Project {
  id: string;
  title: string;
  path: string;
  /** Top-level threads (sub-agent threads not counted). */
  threadCount: number;
  lastActivityAt: string | null;
}

export interface ThreadDetail extends ThreadSummary {
  activeRunId: string | null;
  branch: string | null;
  worktreePath: string | null;
  runCount: number;
  pendingRequestCount: number;
  archived: boolean;
}

export interface ThreadMessage {
  role: string;
  runId: string | null;
  text: string;
}

/** Work an agent left running when its turn ended (T3's `pendingBackgroundTasks`). */
export interface BackgroundTask {
  taskId: string;
  /** `command`, `monitor`, `subagent` or `background_task`. */
  kind: string;
  description: string | null;
  /** The agent said it waits on it (e.g. with `t3_background_wait`). */
  awaited: boolean;
}

export interface StartThreadOptions {
  /** Absolute repo path or T3 project id. */
  project: string;
  /** Always sent through stdin. */
  message: string;
  title: string;
  provider?: string | null;
  model?: string | null;
  worktree?: { baseRef: string; branch: string };
}

export interface T3Health {
  cliFound: boolean;
  serverReachable: boolean;
  version?: string;
  error?: string;
  fake?: boolean;
}

export interface T3Client {
  health(): Promise<T3Health>;
  startThread(o: StartThreadOptions): Promise<{ threadId: string; runId?: string; link?: string }>;
  send(threadId: string, message: string): Promise<{ runId?: string }>;
  show(threadId: string, o?: { messages?: number }): Promise<{ thread: ThreadDetail; messages: ThreadMessage[] }>;
  list(project: string): Promise<ThreadSummary[]>;
  addProject(path: string): Promise<void>;
  /** Settles threads in T3's sidebar. Throws only when T3 cannot be reached at all. */
  settleThreads(threadIds: string[]): Promise<ThreadCommandResult[]>;
  /** The providers enabled in T3 and their models. */
  modelCatalog(): Promise<T3ModelCatalogView>;
  /** The projects T3 knows (the CLI cannot list them). */
  listProjects(): Promise<T3Project[]>;
  /** Background work per thread id, read fresh (the CLI cannot show it). Threads without any are left out. */
  backgroundWork(): Promise<Map<string, BackgroundTask[]>>;
}

export class T3CliError extends Error {
  readonly code: number | string;
  readonly stderr: string;
  readonly stdout: string;
  readonly notFound: boolean;
  readonly timedOut: boolean;
  /** The CLI could not reach the T3 server (or the CLI itself is missing). */
  readonly unavailable: boolean;

  constructor(o: {
    message: string;
    code: number | string;
    stderr?: string;
    stdout?: string;
    notFound?: boolean;
    timedOut?: boolean;
    unavailable?: boolean;
  }) {
    super(o.message);
    this.name = 'T3CliError';
    this.code = o.code;
    this.stderr = o.stderr ?? '';
    this.stdout = o.stdout ?? '';
    this.notFound = o.notFound ?? false;
    this.timedOut = o.timedOut ?? false;
    this.unavailable = o.unavailable ?? false;
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof T3CliError && err.notFound;
}

/** Pulls a PR URL out of `linkedPullRequest` / `pullRequests[0]`, whatever their exact shape. */
export function prUrlOf(t: Pick<ThreadSummary, 'linkedPullRequest' | 'pullRequests'>): string | null {
  const pick = (v: unknown): string | null => {
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of ['url', 'htmlUrl', 'html_url', 'link']) if (typeof o[k] === 'string') return o[k] as string;
    }
    return null;
  };
  return pick(t.linkedPullRequest) ?? pick(t.pullRequests?.[0]);
}

/** PR state when T3 exposes one (spec §4.5 item 7). */
export function prStateOf(t: Pick<ThreadSummary, 'linkedPullRequest' | 'pullRequests'>): string | null {
  const v = (t.linkedPullRequest ?? t.pullRequests?.[0]) as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== 'object') return null;
  const s = v.state ?? v.status;
  if (typeof s === 'string') return s.toLowerCase();
  if (v.merged === true || typeof v.mergedAt === 'string') return 'merged';
  return null;
}

// ---------------------------------------------------------------------------
// JSON normalisation (the CLI output is not a public contract, so be lenient)
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function normalizeSummary(raw: unknown): ThreadSummary {
  const o = (raw ?? {}) as Record<string, unknown>;
  const threadId = str(o.threadId) ?? str(o.id);
  if (!threadId) throw new Error('thread JSON has no threadId');
  return {
    threadId,
    projectId: str(o.projectId),
    title: str(o.title) ?? '',
    link: str(o.link),
    status: str(o.status) ?? 'idle',
    latestRunId: str(o.latestRunId),
    providerInstanceId: str(o.providerInstanceId),
    model: str(o.model),
    runtimeMode: str(o.runtimeMode),
    interactionMode: str(o.interactionMode),
    linkedPullRequest: o.linkedPullRequest ?? null,
    pullRequests: Array.isArray(o.pullRequests) ? o.pullRequests : [],
    itemCount: num(o.itemCount),
    runCount: typeof o.runCount === 'number' ? o.runCount : undefined,
    settled: typeof o.settled === 'boolean' ? o.settled : undefined,
    parentThreadId: str(o.parentThreadId) ?? str((o.lineage as Record<string, unknown> | undefined)?.parentThreadId),
    createdAt: str(o.createdAt) ?? new Date(0).toISOString(),
    updatedAt: str(o.updatedAt) ?? new Date(0).toISOString(),
  };
}

export function normalizeDetail(raw: unknown): ThreadDetail {
  const o = (raw ?? {}) as Record<string, unknown>;
  const s = normalizeSummary(o);
  return {
    ...s,
    activeRunId: str(o.activeRunId),
    branch: str(o.branch),
    worktreePath: str(o.worktreePath),
    runCount: num(o.runCount, s.latestRunId ? 1 : 0),
    pendingRequestCount: num(o.pendingRequestCount),
    archived: o.archived === true,
  };
}

export function normalizeMessages(raw: unknown): ThreadMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => {
    const o = (m ?? {}) as Record<string, unknown>;
    return { role: str(o.role) ?? 'unknown', runId: str(o.runId), text: str(o.text) ?? '' };
  });
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * The enabled providers and their models out of T3's `server.getConfig` result, with the user's
 * hidden models flagged and their model order applied (both from T3's settings).
 */
export function normalizeModelCatalog(raw: unknown): T3ModelCatalogView {
  const o = (raw ?? {}) as Record<string, unknown>;
  const settings = (o.settings ?? {}) as Record<string, unknown>;
  const prefs = (settings.providerModelPreferences ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const providers = (Array.isArray(o.providers) ? o.providers : []).flatMap((p): T3ProviderView[] => {
    const x = (p ?? {}) as Record<string, unknown>;
    const id = str(x.instanceId);
    if (!id || x.enabled === false) return [];
    const hidden = new Set(strs(prefs[id]?.hiddenModels));
    const order = strs(prefs[id]?.modelOrder);
    const rank = (slug: string) => (order.includes(slug) ? order.indexOf(slug) : order.length);
    const models = (Array.isArray(x.models) ? x.models : [])
      .flatMap((m): T3ModelView[] => {
        const y = (m ?? {}) as Record<string, unknown>;
        const slug = str(y.slug);
        return slug ? [{ slug, name: str(y.name) ?? slug, isDefault: y.isDefault === true, hidden: hidden.has(slug) }] : [];
      })
      .sort((a, b) => rank(a.slug) - rank(b.slug));
    return [{ id, name: str(x.displayName) ?? id, status: str(x.status) ?? 'unknown', models }];
  });
  const selection = (settings.defaultModelSelection ?? {}) as Record<string, unknown>;
  return { defaultProvider: str(selection.instanceId), providers };
}

/**
 * The projects out of T3's shell snapshot (`orchestration.subscribeShell`), most recently active
 * first. Archived and deleted projects and threads are left out, and so are sub-agent threads.
 */
export function normalizeProjects(raw: unknown): T3Project[] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown> | null>) : []).filter((x): x is Record<string, unknown> => !!x);
  const counts = new Map<string, { n: number; last: string | null }>();
  for (const t of list(o.threads)) {
    const projectId = str(t.projectId);
    const lineage = (t.lineage ?? {}) as Record<string, unknown>;
    if (!projectId || str(lineage.parentThreadId) || str(t.deletedAt) || str(t.archivedAt)) continue;
    const at = str(t.latestUserMessageAt) ?? str(t.updatedAt);
    const c = counts.get(projectId) ?? { n: 0, last: null };
    c.n++;
    if (at && (!c.last || at > c.last)) c.last = at;
    counts.set(projectId, c);
  }
  return list(o.projects)
    .flatMap((p): T3Project[] => {
      const id = str(p.id);
      const path = str(p.workspaceRoot);
      if (!id || !path || str(p.archivedAt) || str(p.deletedAt)) return [];
      const c = counts.get(id);
      return [{ id, title: str(p.title) ?? path, path, threadCount: c?.n ?? 0, lastActivityAt: c?.last ?? str(p.updatedAt) }];
    })
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
}

/** Each thread's `pendingBackgroundTasks` out of T3's shell snapshot, for threads that have any. */
export function normalizeBackgroundWork(raw: unknown): Map<string, BackgroundTask[]> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out = new Map<string, BackgroundTask[]>();
  for (const t of Array.isArray(o.threads) ? (o.threads as Array<Record<string, unknown> | null>) : []) {
    const id = str(t?.id);
    if (!id || !Array.isArray(t?.pendingBackgroundTasks)) continue;
    const tasks = (t.pendingBackgroundTasks as Array<Record<string, unknown> | null>).flatMap((x): BackgroundTask[] => {
      const taskId = str(x?.taskId);
      return taskId ? [{ taskId, kind: str(x?.kind) ?? 'background_task', description: str(x?.description)?.trim() || null, awaited: x?.awaited === true }] : [];
    });
    if (tasks.length) out.set(id, tasks);
  }
  return out;
}

/**
 * The work that keeps a finished turn open, by T3's own rule (`backgroundWorkHoldsCompletion`; T3's
 * sidebar shows such a thread as running): sub-agents and background tasks, and commands or monitors
 * the agent said it waits on. Other commands are mostly dev servers. Pull request watches are left
 * out: they last until the PR merges.
 */
export function holdingWork(tasks: BackgroundTask[]): BackgroundTask[] {
  return tasks.filter(
    (t) => !t.taskId.startsWith('pull-request-watch:') && (t.awaited || t.kind === 'subagent' || t.kind === 'background_task'),
  );
}

/**
 * `t3 thread start` takes `--provider` and `--model` together or not at all, so fill in the
 * missing half: a model alone runs on a provider that offers it (T3's default provider first), a
 * provider alone runs its default model. Null when neither is set (T3 uses the project default).
 */
export function resolveModelSelection(
  catalog: T3ModelCatalogView,
  provider: string | null | undefined,
  model: string | null | undefined,
): { provider: string; model: string } | null {
  if (provider && model) return { provider, model };
  if (model) {
    const isDefault = (p: T3ProviderView) => (p.id === catalog.defaultProvider ? 0 : 1);
    const p = [...catalog.providers].sort((a, b) => isDefault(a) - isDefault(b)).find((p) => p.models.some((m) => m.slug === model));
    if (!p) throw new Error(`no provider enabled in T3 offers the model "${model}"; pick a provider or another model in the board settings`);
    return { provider: p.id, model };
  }
  if (provider) {
    const models = catalog.providers.find((p) => p.id === provider)?.models ?? [];
    const m = models.find((m) => m.isDefault) ?? models[0];
    if (!m) throw new Error(`the provider "${provider}" is not enabled in T3 or offers no models`);
    return { provider, model: m.slug };
  }
  return null;
}
