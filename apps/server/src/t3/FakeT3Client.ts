// Scripted fake T3 (spec §11.1, `T3ORCHESTRA_FAKE_T3=1`).
//
// Two modes:
// - manual (tests): nothing happens on its own; tests drive threads with setStatus/finishRun/….
// - autoplay (dev): every run plays a short timeline and ends with a plausible result block, so
//   the UI can be exercised without real agents. With `gitDir` set, task threads get real git
//   worktrees and commits, so diffs and merges work too.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { T3ModelCatalogView } from '@t3-orchestra/shared';
import { execa } from 'execa';
import { slugify } from '../util.ts';
import {
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

interface FakeThread {
  detail: ThreadDetail;
  project: string;
  messages: ThreadMessage[];
  /** Messages sent while a run was active; each becomes the next run. */
  queue: string[];
  timers: NodeJS.Timeout[];
  /** Work the agent left running after its turn (setBackground). */
  background?: BackgroundTask[];
  /** A knowledge build's first prompt (its correction is answered from it). */
  knowledgePrompt?: string;
  /** Planner threads: what the last message asked for (a correction repeats it), spec rounds so far, the goal. */
  planPhase?: 'spec' | 'plan';
  specRounds?: number;
  specGoal?: string;
  specDecisions?: string[];
  planRuns?: number;
}

export interface FakeOptions {
  autoplay?: boolean;
  /** Directory for fake worktrees (autoplay only). Null disables git work. */
  gitDir?: string | null;
  /** Speed multiplier for autoplay timelines (1 = default, 0.1 = 10x faster). */
  timeScale?: number;
  /** When false, list() of an unknown project fails until addProject() is called. */
  allProjectsKnown?: boolean;
}

const norm = (p: string) => path.resolve(p).toLowerCase();

/** One earlier thread for seedHistory. */
export interface HistoryItem {
  title: string;
  ask: string;
  reply: string;
  daysAgo?: number;
  settled?: boolean;
  status?: string;
  branch?: string | null;
  parentThreadId?: string;
}

export class FakeT3Client implements T3Client {
  readonly threads = new Map<string, FakeThread>();
  readonly knownProjects = new Set<string>();
  /** Normalized project path → the path as first given (for listProjects). */
  private readonly projectPaths = new Map<string, string>();
  /** Projects that already got their demo history (autoplay). */
  private readonly seeded = new Set<string>();
  healthy = true;
  /** Test hooks: make the next start/send throw (after optionally creating the thread). */
  failNextStart: null | { afterCreate: boolean } = null;
  failNextSend: null | { afterSend: boolean } = null;
  /** Test hook: make the next backgroundWork() fail like a dropped `/ws` connection. */
  failNextBackground = false;
  calls: Array<{ op: string; args: unknown }> = [];
  private seq = 0;

  constructor(private readonly opts: FakeOptions = {}) {}

  private ensureHealthy() {
    if (!this.healthy) throw new T3CliError({ message: 'T3 Code server is not running', code: 1, unavailable: true });
  }

  async health(): Promise<T3Health> {
    return this.healthy
      ? { cliFound: true, serverReachable: true, version: 'fake', fake: true }
      : { cliFound: true, serverReachable: false, error: 'fake T3 is down', fake: true };
  }

  async startThread(o: StartThreadOptions): Promise<{ threadId: string; runId?: string; link?: string }> {
    this.calls.push({ op: 'start', args: o });
    this.ensureHealthy();
    const fail = this.failNextStart;
    this.failNextStart = null;
    if (fail && !fail.afterCreate) throw new T3CliError({ message: 'fake start failed', code: 1 });

    const id = `fake-${++this.seq}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const runId = `run:thread:${id}:ordinal:1`;
    const detail: ThreadDetail = {
      threadId: id,
      projectId: `proj-${slugify(o.project, 20)}`,
      title: o.title,
      link: `https://app.t3.codes/threads/fake-env/${id}`,
      status: 'starting',
      latestRunId: runId,
      activeRunId: runId,
      providerInstanceId: o.provider ?? 'claudeAgent',
      model: o.model ?? 'fake-model',
      runtimeMode: 'full-access',
      interactionMode: 'default',
      linkedPullRequest: null,
      pullRequests: [],
      itemCount: 1,
      runCount: 1,
      settled: false,
      pendingRequestCount: 0,
      archived: false,
      branch: o.worktree?.branch ?? null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    };
    const t: FakeThread = { detail, project: o.project, messages: [{ role: 'user', runId, text: o.message }], queue: [], timers: [] };
    this.threads.set(id, t);
    this.noteProject(o.project);

    if (o.worktree && this.opts.autoplay && this.opts.gitDir) {
      detail.worktreePath = await this.addWorktree(o.project, o.worktree.baseRef, o.worktree.branch).catch((err) => {
        console.warn(`[fake-t3] git worktree add failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    } else if (o.worktree) {
      detail.worktreePath = path.join(this.opts.gitDir ?? 'C:\\fake-worktrees', slugify(o.worktree.branch, 60));
    }

    if (fail?.afterCreate) throw new T3CliError({ message: 'fake start timed out', code: 'ETIMEDOUT', timedOut: true });
    if (this.opts.autoplay) this.play(t, o.message);
    return { threadId: id, runId, link: detail.link ?? undefined };
  }

  async send(threadId: string, message: string): Promise<{ runId?: string }> {
    this.calls.push({ op: 'send', args: { threadId, message } });
    this.ensureHealthy();
    const t = this.get(threadId);
    const fail = this.failNextSend;
    this.failNextSend = null;
    if (fail && !fail.afterSend) throw new T3CliError({ message: 'fake send failed', code: 1 });
    const busy = ['preparing', 'queued', 'starting', 'running', 'waiting'].includes(t.detail.status);
    let runId: string | undefined;
    if (busy) t.queue.push(message);
    else runId = this.beginRun(t, message);
    if (fail?.afterSend) throw new T3CliError({ message: 'fake send timed out', code: 'ETIMEDOUT', timedOut: true });
    return { runId };
  }

  async show(threadId: string, o: { messages?: number } = {}): Promise<{ thread: ThreadDetail; messages: ThreadMessage[] }> {
    this.ensureHealthy();
    const t = this.get(threadId);
    const n = o.messages ?? 20;
    return { thread: structuredClone(t.detail), messages: structuredClone(t.messages.slice(-n)) };
  }

  async list(project: string): Promise<ThreadSummary[]> {
    this.ensureHealthy();
    if (this.opts.allProjectsKnown === false && !this.knownProjects.has(norm(project))) {
      throw new T3CliError({ message: `No project found for ${project}`, code: 1 });
    }
    if (this.opts.autoplay && !project.startsWith('proj-')) this.seedDemoHistory(project);
    return [...this.threads.values()]
      .filter((t) => norm(t.project) === norm(project) || t.detail.projectId === project)
      .map((t) => {
        const { activeRunId, branch, worktreePath, pendingRequestCount, archived, runCount, ...summary } = t.detail;
        void activeRunId, branch, worktreePath, pendingRequestCount, archived, runCount;
        return structuredClone(summary);
      })
      .reverse();
  }

  async addProject(p: string): Promise<void> {
    this.ensureHealthy();
    this.knownProjects.add(norm(p));
    this.noteProject(p);
    if (this.opts.autoplay) this.seedDemoHistory(p);
  }

  /** Every project added or with threads, most recently active first. */
  async listProjects(): Promise<T3Project[]> {
    this.ensureHealthy();
    return [...this.projectPaths.entries()]
      .map(([key, p]): T3Project => {
        const threads = [...this.threads.values()].filter((t) => norm(t.project) === key && !t.detail.parentThreadId);
        const last = threads.map((t) => t.detail.updatedAt).sort().at(-1) ?? null;
        return { id: `proj-${slugify(p, 20)}`, title: path.basename(p), path: p, threadCount: threads.length, lastActivityAt: last };
      })
      .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  }

  async backgroundWork(): Promise<Map<string, BackgroundTask[]>> {
    this.calls.push({ op: 'backgroundWork', args: null });
    this.ensureHealthy();
    if (this.failNextBackground) {
      this.failNextBackground = false;
      throw new T3CliError({ message: 'T3 Code closed the connection (1006)', code: 'EWS', unavailable: true });
    }
    const out = new Map<string, BackgroundTask[]>();
    for (const [id, t] of this.threads) if (t.background?.length) out.set(id, structuredClone(t.background));
    return out;
  }

  async settleThreads(threadIds: string[]): Promise<ThreadCommandResult[]> {
    this.calls.push({ op: 'settle', args: threadIds });
    this.ensureHealthy();
    return threadIds.map((threadId) => {
      const t = this.threads.get(threadId);
      if (!t) return { threadId, ok: false, notFound: true, error: `No orchestration projection exists for thread ${threadId}.` };
      t.detail.settled = true;
      return { threadId, ok: true, notFound: false };
    });
  }

  async modelCatalog(): Promise<T3ModelCatalogView> {
    this.ensureHealthy();
    const model = (slug: string, name: string, isDefault = false, hidden = false) => ({ slug, name, isDefault, hidden });
    return {
      defaultProvider: 'claudeAgent',
      providers: [
        {
          id: 'claudeAgent',
          name: 'Claude',
          status: 'ready',
          models: [
            model('claude-opus-5-5', 'Claude Opus 5.5', true),
            model('claude-sonnet-5-5', 'Claude Sonnet 5.5'),
            model('claude-haiku-5-5', 'Claude Haiku 5.5'),
            model('claude-opus-4-8', 'Claude Opus 4.8', false, true),
          ],
        },
        { id: 'codex', name: 'Codex', status: 'ready', models: [model('gpt-5.5', 'GPT-5.5', true), model('gpt-5.5-mini', 'GPT-5.5 Mini')] },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Test controls
  // -------------------------------------------------------------------------

  /**
   * Adds finished threads to a project, as if the user had worked in it in T3 before. Each item is
   * one thread with the user's ask and the agent's last reply; `daysAgo` sets its dates.
   */
  seedHistory(project: string, items: HistoryItem[]): string[] {
    this.noteProject(project);
    return items.map((item, i) => {
      const id = `fake-h${++this.seq}-${Math.random().toString(36).slice(2, 8)}`;
      const at = new Date(Date.now() - (item.daysAgo ?? items.length - i) * 86_400_000).toISOString();
      const runId = `run:thread:${id}:ordinal:1`;
      const detail: ThreadDetail = {
        threadId: id,
        projectId: `proj-${slugify(project, 20)}`,
        title: item.title,
        link: `https://app.t3.codes/threads/fake-env/${id}`,
        status: item.status ?? 'completed',
        latestRunId: runId,
        activeRunId: null,
        providerInstanceId: 'claudeAgent',
        model: 'fake-model',
        runtimeMode: 'full-access',
        interactionMode: 'default',
        linkedPullRequest: null,
        pullRequests: [],
        itemCount: 6,
        runCount: 1,
        settled: item.settled ?? true,
        parentThreadId: item.parentThreadId ?? null,
        pendingRequestCount: 0,
        archived: false,
        branch: item.branch ?? null,
        worktreePath: null,
        createdAt: at,
        updatedAt: at,
      };
      const messages: ThreadMessage[] = [
        { role: 'user', runId, text: item.ask },
        { role: 'assistant', runId, text: 'Looking at the code first.' },
        { role: 'assistant', runId, text: item.reply },
      ];
      this.threads.set(id, { detail, project, messages, queue: [], timers: [] });
      return id;
    });
  }

  private noteProject(project: string) {
    if (project.startsWith('proj-')) return;
    if (!this.projectPaths.has(norm(project))) this.projectPaths.set(norm(project), project);
  }

  /** Autoplay: a project seen for the first time gets a few earlier threads, so an import has something to read. */
  private seedDemoHistory(project: string) {
    const key = norm(project);
    if (this.seeded.has(key)) return;
    this.seeded.add(key);
    if ([...this.threads.values()].some((t) => norm(t.project) === key)) return;
    this.seedHistory(project, DEMO_HISTORY);
  }

  get(threadId: string): FakeThread {
    const t = this.threads.get(threadId);
    if (!t) throw new T3CliError({ message: `Thread ${threadId} is no longer available.`, code: 1, notFound: true });
    return t;
  }

  findByTitle(substr: string): FakeThread | undefined {
    return [...this.threads.values()].find((t) => t.detail.title.includes(substr));
  }

  setStatus(threadId: string, status: string, extra: Partial<ThreadDetail> = {}): void {
    const t = this.get(threadId);
    Object.assign(t.detail, { status, ...extra, updatedAt: this.tick(), itemCount: t.detail.itemCount + 1 });
  }

  /** Ends the current run with an assistant message (and starts the next queued message, if any). */
  finishRun(threadId: string, text: string, status = 'completed'): void {
    const t = this.get(threadId);
    t.messages.push({ role: 'assistant', runId: t.detail.latestRunId, text });
    Object.assign(t.detail, { status, activeRunId: null, pendingRequestCount: 0, updatedAt: this.tick(), itemCount: t.detail.itemCount + 3 });
    const next = t.queue.shift();
    if (next !== undefined) this.beginRun(t, next);
  }

  /** Adds an assistant message to the current run without ending it (an agent's progress message). */
  say(threadId: string, text: string): void {
    const t = this.get(threadId);
    t.messages.push({ role: 'assistant', runId: t.detail.latestRunId, text });
    Object.assign(t.detail, { updatedAt: this.tick(), itemCount: t.detail.itemCount + 1 });
  }

  /** Sets the work the agent left running after its turn (none clears it). */
  setBackground(threadId: string, tasks: Array<Partial<BackgroundTask> & { description: string }> = []): void {
    this.get(threadId).background = tasks.map((x, i) => ({ taskId: `bg${i + 1}`, kind: 'command', awaited: true, ...x }));
  }

  /** Starts a run with no user message: the agent going on by itself (its background work came back). */
  agentContinues(threadId: string): string {
    const t = this.get(threadId);
    const ordinal = (t.detail.runCount ?? 0) + 1;
    const runId = `run:thread:${t.detail.threadId}:ordinal:${ordinal}`;
    Object.assign(t.detail, { status: 'running', latestRunId: runId, activeRunId: runId, runCount: ordinal, updatedAt: this.tick(), itemCount: t.detail.itemCount + 1 });
    return runId;
  }

  /** Starts a run the board did not ask for (the user chatting in T3). */
  externalRun(threadId: string, text = 'user message from T3'): string {
    return this.beginRun(this.get(threadId), text);
  }

  removeThread(threadId: string): void {
    const t = this.threads.get(threadId);
    t?.timers.forEach(clearTimeout);
    this.threads.delete(threadId);
  }

  dispose(): void {
    for (const t of this.threads.values()) t.timers.forEach(clearTimeout);
  }

  private tick(): string {
    // Strictly increasing timestamps, even within the same millisecond.
    const last = Math.max(0, ...[...this.threads.values()].map((t) => Date.parse(t.detail.updatedAt)));
    return new Date(Math.max(Date.now(), last + 1)).toISOString();
  }

  private beginRun(t: FakeThread, message: string): string {
    const ordinal = (t.detail.runCount ?? 0) + 1;
    const runId = `run:thread:${t.detail.threadId}:ordinal:${ordinal}`;
    t.messages.push({ role: 'user', runId, text: message });
    Object.assign(t.detail, {
      status: 'running',
      latestRunId: runId,
      activeRunId: runId,
      runCount: ordinal,
      updatedAt: this.tick(),
      itemCount: t.detail.itemCount + 1,
    });
    if (this.opts.autoplay) this.play(t, message);
    return runId;
  }

  // -------------------------------------------------------------------------
  // Autoplay
  // -------------------------------------------------------------------------

  private after(t: FakeThread, ms: number, fn: () => void | Promise<void>) {
    const scale = this.opts.timeScale ?? 1;
    t.timers.push(
      setTimeout(() => {
        if (!this.threads.has(t.detail.threadId)) return;
        void Promise.resolve(fn()).catch(() => undefined);
      }, ms * scale),
    );
  }

  private play(t: FakeThread, message: string) {
    const title = t.detail.title;
    const isPlan = / plan-\d+\]/.test(title);
    const isChat = / ask-\d+\]/.test(title);
    const isIdeas = / idea-\d+\]/.test(title);
    const isImport = / import-\d+\]/.test(title);
    const isAudit = / sec-\d+\]/.test(title);
    const isKnowledge = / ctx-\d+\]/.test(title);
    const reviewRound = /-\d+ r(\d+)\]/.exec(title)?.[1];
    const id = t.detail.threadId;

    this.after(t, 600, () => this.setStatus(id, 'running'));
    for (let i = 1; i <= 4; i++) this.after(t, 600 + i * 900, () => this.setStatus(id, 'running'));

    if (isAudit) {
      this.after(t, 1500, () => this.say(id, 'Mapping the entry points, the auth layer and where user input goes.'));
      this.after(t, 4000, () => this.say(id, 'Tracing request bodies from the API routes to the database and the shell.'));
      this.after(t, 7500, () => this.finishRun(id, message.startsWith('Your audit result could not be used') ? fakeAuditReply('') : fakeAuditReply(message)));
      return;
    }

    if (isKnowledge) {
      this.after(t, 1500, () => this.say(id, 'Reading the files and checking what they name against the code.'));
      // A correction gets the first prompt's answer again (the fake keeps it whole).
      if (!message.startsWith('Your knowledge graph result could not be used')) t.knowledgePrompt = message;
      // After the last "running" heartbeat (4.2 s), or it would mark the finished run running again.
      this.after(t, 5000, () => this.finishRun(id, fakeKnowledgeReply(t.knowledgePrompt ?? message)));
      return;
    }

    if (isPlan) {
      const correction = /could not be used/.test(message);
      t.planPhase = correction ? (t.planPhase ?? 'plan') : /agree on a spec|read your spec and sent this back/.test(message) ? 'spec' : 'plan';
      if (t.planPhase === 'spec') {
        if (!correction) t.specRounds = (t.specRounds ?? 0) + 1;
        t.specGoal ??= /## GOAL\s*\n([\s\S]*?)(\n## |$)/.exec(message)?.[1]?.trim();
        this.after(t, 1500, () => this.say(id, 'Reading the code around the goal and drafting the spec.'));
        this.after(t, 5000, () => this.finishRun(id, fakeSpecReply(t, correction ? '' : message)));
        return;
      }
      if (!correction) t.planRuns = (t.planRuns ?? 0) + 1;
      if (/The user is happy with the spec/.test(message)) {
        const goal = /## Goal\s*\n(.+)/.exec(message)?.[1]?.trim() ?? t.specGoal ?? 'the goal';
        this.after(t, 5000, () => this.finishRun(id, fakePlanReply(`## GOAL\n${goal}`, t.planRuns ?? 1)));
        return;
      }
      const asks = /ask the user\s+concise clarifying questions/i.test(message) && t.detail.runCount === 1 && /\?\s*$/m.test(message);
      if (asks) {
        this.after(t, 2500, () => this.setStatus(id, 'waiting', { pendingRequestCount: 1 }));
        this.after(t, 9000, () => this.setStatus(id, 'running', { pendingRequestCount: 0 }));
      }
      this.after(t, asks ? 12_000 : 5000, () => this.finishRun(id, fakePlanReply(message, t.detail.runCount)));
      return;
    }

    if (isChat) {
      const question = /## Question\s*\n([\s\S]*)$/.exec(message)?.[1]?.trim() ?? message.trim();
      // "wait for me" in a question makes the fake agent wait for the user in T3 for a while.
      const waits = /\bwait for me\b/i.test(question);
      if (waits) {
        this.after(t, 1200, () => this.setStatus(id, 'waiting', { pendingRequestCount: 1 }));
        this.after(t, 7000, () => this.setStatus(id, 'running', { pendingRequestCount: 0 }));
      }
      this.after(t, 1500, () => this.say(id, 'Let me look at the project layout first.'));
      this.after(t, 3000, () => this.say(id, 'Now reading the entry points and the README.'));
      if (/\bbackground\b/i.test(question)) {
        // Like a real agent with background sub-agents: the turn ends early and T3 resumes the
        // thread on its own (a run with no user message) once the work comes back.
        this.after(t, 5000, () => {
          this.finishRun(id, "Two background checks are still running. I'll post the findings when they're back.");
          this.setBackground(id, [
            { description: 'Check the auth flow', kind: 'subagent', awaited: false },
            { description: 'Check the data layer', kind: 'subagent', awaited: false },
          ]);
        });
        this.after(t, 9000, () => {
          this.setBackground(id);
          void this.agentContinues(id);
        });
        this.after(t, 10_500, () => this.say(id, 'Both checks are back; putting it together.'));
        this.after(t, 13_000, () => this.finishRun(id, fakeInsightReply(question)));
        return;
      }
      this.after(t, waits ? 9000 : 5000, () => this.finishRun(id, fakeInsightReply(question)));
      return;
    }

    if (isImport) {
      this.after(t, 1500, () => this.say(id, 'Reading the thread digest first, newest threads first.'));
      this.after(t, 3500, () => this.say(id, 'Checking the README, the git log and the open branches against what the threads say.'));
      this.after(t, 7000, () => this.finishRun(id, fakeImportReply(message)));
      return;
    }

    if (isIdeas) {
      this.after(t, 1500, () => this.say(id, 'Reading the project layout and the main modules.'));
      this.after(t, 6000, () => this.finishRun(id, message.startsWith('You are the Marketing agent') ? fakeMarketingReply(message) : fakeIdeasReply(message)));
      return;
    }

    if (reviewRound) {
      const num = Number(/-(\d+) r\d+\]/.exec(title)?.[1] ?? 0);
      const changes = Number(reviewRound) === 1 && num % 2 === 0;
      this.after(t, 5000, () => this.finishRun(id, fakeReviewReply(changes, num, title)));
      return;
    }

    // Task thread run.
    const askFirst = /\bask\b|\bquestion\b/i.test(title) && t.detail.runCount === 1;
    if (askFirst) {
      this.after(t, 2500, () => this.setStatus(id, 'waiting', { pendingRequestCount: 1 }));
      this.after(t, 12_000, () => this.setStatus(id, 'running', { pendingRequestCount: 0 }));
    }
    const isPr = /open a pull request/i.test(message);
    const isRebase = /has moved since you started/i.test(message);
    const blocked = /\bblock(ed)?\b/i.test(title) && t.detail.runCount === 1;
    // "background" in the title: the first turn ends while the full test suite still runs in the
    // background, and T3 resumes the thread by itself once it is done.
    const inBackground = /\bbackground\b/i.test(title) && t.detail.runCount === 1;
    // "design" in the title: the first run makes HTML options instead of building, and so does "another round".
    const designFolder = fakeDesignFolder(message);
    const makesOptions = designFolder && /design/i.test(title) && (t.detail.runCount === 1 || /another round of options/.test(message));
    if (makesOptions) {
      this.after(t, 1500, () => this.say(id, 'The task leaves the layout open; sketching a few options first.'));
      this.after(t, 6000, () => {
        const round = Number(/[\\/](\d+)$/.exec(designFolder)?.[1] ?? 1);
        this.finishRun(id, saveFakeDesignOptions(designFolder, round));
      });
      return;
    }
    this.after(t, askFirst ? 15_000 : 7000, async () => {
      if (t.detail.worktreePath && this.opts.gitDir && !blocked) {
        await this.fakeCommit(t, message, isRebase).catch(() => undefined);
      }
      if (!blocked && /\bUI\b|screen/i.test(title)) saveFakeScreenshots(message);
      if (isPr) {
        const n = 100 + this.seq;
        t.detail.pullRequests = [{ url: `https://github.com/example/repo/pull/${n}`, number: n, state: 'open' }];
        t.detail.linkedPullRequest = t.detail.pullRequests[0];
      }
      if (!inBackground) return this.finishRun(id, fakeImplementReply(blocked, isPr));
      this.finishRun(id, "The full test suite is still running in the background. I'll report its result when it finishes.");
      this.setBackground(id, [{ description: 'Run the full test suite' }]);
      this.after(t, 12_000, () => {
        this.setBackground(id);
        void this.agentContinues(id);
      });
      this.after(t, 13_500, () => this.say(id, 'The full suite passed.'));
      this.after(t, 15_000, () => this.finishRun(id, fakeImplementReply(false, false)));
    });
  }

  private async addWorktree(project: string, baseRef: string, branch: string): Promise<string> {
    // Short directory names: Windows paths over 260 chars break `git worktree add`.
    const hash = createHash('sha1').update(`${project}\0${branch}`).digest('hex').slice(0, 10);
    const dir = path.join(this.opts.gitDir!, `wt-${hash}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await execa('git', ['-C', project, 'worktree', 'add', '-b', branch, dir, baseRef]);
    return dir;
  }

  private async fakeCommit(t: FakeThread, message: string, rebase: boolean) {
    const wt = t.detail.worktreePath!;
    const git = (...a: string[]) => execa('git', ['-C', wt, '-c', 'user.name=Fake Agent', '-c', 'user.email=fake@t3orchestra', ...a]);
    if (rebase) {
      const base = /`([^`]+)` has moved/.exec(message)?.[1] ?? 'main';
      await git('merge', '--no-edit', '-X', 'ours', base);
    }
    const file = path.join(wt, 'fake-agent', `${slugify(t.detail.branch ?? 'task', 50)}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `- run ${t.detail.runCount} at ${new Date().toISOString()}\n`);
    await git('add', '-A');
    const num = /^#(\d+)/.exec(t.detail.title)?.[1] ?? '0';
    await git('commit', '-m', `#${num}: fake agent run ${t.detail.runCount}`);
  }
}

/** UI tasks: writes two made-up "screenshots" into the folder the implement prompt names. */
function saveFakeScreenshots(message: string) {
  const dir = /outside the repo:\s*\r?\n[ \t]*(\S.*?)\s*$/m.exec(message)?.[1];
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main-screen.png'), fakeScreenPng([94, 106, 210]));
  fs.writeFileSync(path.join(dir, 'empty-state.png'), fakeScreenPng([46, 160, 110]));
}

/** The design folder a prompt names, if it offers design options. */
function fakeDesignFolder(message: string): string | null {
  return /design folder \(outside the repo, never commit it\):\s*\r?\n[ \t]*(\S.*?)\s*$/m.exec(message)?.[1] ?? null;
}

const FAKE_LAYOUTS = [
  { file: 'a-sidebar-nav.html', title: 'Sidebar navigation', summary: 'Sections in a left sidebar; roomy, but takes width on small screens.' },
  { file: 'b-top-tabs.html', title: 'Top tabs', summary: 'Tabs across the top; compact, fits phones, fewer sections fit.' },
  { file: 'c-card-grid.html', title: 'Card grid', summary: 'Everything as cards on one page; easy to scan, long on phones.' },
];

/** Writes three made-up HTML mock-ups into the round's folder and returns the agent's reply. */
function saveFakeDesignOptions(dir: string, round: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const hue = (round * 47) % 360;
  for (const [i, o] of FAKE_LAYOUTS.entries()) fs.writeFileSync(path.join(dir, o.file), fakeDesignPage(i, o.title, hue, round));
  return `I made ${FAKE_LAYOUTS.length} options (round ${round}).${block({
    status: 'options',
    summary: `Three layouts for the settings page (round ${round}).`,
    question: 'Which layout should the settings page use?',
    options: FAKE_LAYOUTS,
  })}`;
}

function fakeDesignPage(kind: number, title: string, hue: number, round: number): string {
  const sections = ['General', 'Notifications', 'Appearance', 'Members', 'Billing'];
  const field = (label: string, value: string) =>
    `<label><span>${label}</span><input value="${value}"></label>`;
  const form = `<h2>General</h2>${field('Board name', 'my-app')}${field('Base branch', 'main')}<button>Save changes</button>`;
  const nav =
    kind === 0
      ? `<aside>${sections.map((s, i) => `<a class="${i === 0 ? 'on' : ''}" href="#">${s}</a>`).join('')}</aside>`
      : kind === 1
        ? `<nav>${sections.map((s, i) => `<a class="${i === 0 ? 'on' : ''}" href="#">${s}</a>`).join('')}</nav>`
        : '';
  const body = kind === 2 ? `<div class="grid">${sections.map((s) => `<section><h2>${s}</h2><p>Settings for ${s.toLowerCase()}.</p><button>Open</button></section>`).join('')}</div>` : `<section>${form}</section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>
:root { --accent: hsl(${hue} 70% 58%); --bg: #15171c; --card: #1d2027; --line: #2b2f38; --text: #e7e9ee; --muted: #9aa0ab; }
* { box-sizing: border-box; } body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--text); }
header { padding: 14px 20px; border-bottom: 1px solid var(--line); font-weight: 600; } header small { color: var(--muted); font-weight: 400; margin-left: 8px; }
main { display: flex; gap: 20px; padding: 20px; flex-direction: ${kind === 0 ? 'row' : 'column'}; }
aside { width: 200px; display: flex; flex-direction: column; gap: 2px; } nav { display: flex; gap: 4px; border-bottom: 1px solid var(--line); overflow-x: auto; }
a { color: var(--muted); text-decoration: none; padding: 8px 12px; border-radius: 6px; white-space: nowrap; } a.on { color: var(--text); background: var(--card); box-shadow: inset 3px 0 var(--accent); }
nav a.on { box-shadow: inset 0 -2px var(--accent); background: none; border-radius: 0; }
section { flex: 1; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 18px; } h2 { margin: 0 0 12px; font-size: 15px; }
label { display: block; margin-bottom: 12px; } label span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
input { width: 100%; max-width: 360px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
button { background: var(--accent); color: #111; border: 0; border-radius: 6px; padding: 8px 14px; font-weight: 600; cursor: pointer; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; } .grid p { color: var(--muted); }
@media (max-width: 600px) { main { flex-direction: column; } aside { width: auto; flex-direction: row; overflow-x: auto; } }
</style></head><body><header>Settings<small>${title} · round ${round} (fake agent)</small></header><main>${nav}${body}</main></body></html>`;
}

/** A 960x600 PNG of a generic app layout (top bar, sidebar, cards in the accent colour). */
function fakeScreenPng(accent: [number, number, number]): Buffer {
  const w = 960;
  const h = 600;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const card = x > 220 && x < 930 && y > 90 && (x - 220) % 240 < 210 && (y - 90) % 170 < 140;
      const px =
        y < 48 ? [35, 38, 46] : x < 190 ? [28, 31, 38] : card ? (y - 90) % 170 < 6 ? accent : [44, 48, 58] : [22, 24, 29];
      raw.set(px, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

// ---------------------------------------------------------------------------
// Canned replies
// ---------------------------------------------------------------------------

function block(obj: unknown): string {
  return `\n\n\`\`\`t3orchestra-result\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
}

let fakeAuditRounds = 0;

/**
 * A security audit: new findings each round (so repeats aren't dropped), and the first earlier audit
 * finding the prompt asks it to re-check comes back as fixed.
 */
function fakeAuditReply(message: string): string {
  const n = ++fakeAuditRounds;
  const suffix = n > 1 ? ` (${n})` : '';
  const toCheck = /From earlier audits[\s\S]*?\n((?:- S-\d+.*\n?)+)/.exec(message)?.[1] ?? '';
  const resolved = /- (S-\d+)/.exec(toCheck)?.[1];
  const findings = [
    {
      title: `SQL built from the search query string${suffix}`,
      severity: 'critical',
      category: 'injection',
      file: 'src/api/search.ts',
      line: 42,
      description: 'The search endpoint pastes `q` into a SQL string, so any visitor can read or change the whole database.',
      details: '```ts\nconst rows = db.prepare(`SELECT * FROM items WHERE name LIKE \'%${q}%\'`).all();\n```\nReached from `GET /api/search?q=` without sign-in.',
      recommendation: 'Use a bound parameter: `db.prepare("SELECT * FROM items WHERE name LIKE ?").all(`%${q}%`)`.',
      cwe: 'CWE-89',
      confidence: 'high',
      acceptanceCriteria: ['The search query is passed as a bound parameter', 'A test with a quote in `q` returns no error and no extra rows'],
      touches: ['src/api/search.ts'],
    },
    {
      title: `Admin routes only check that a user is signed in${suffix}`,
      severity: 'high',
      category: 'access_control',
      file: 'src/api/admin.ts',
      line: 12,
      description: 'Any signed-in user can call the admin endpoints, including the one that deletes accounts.',
      details: 'The router uses `requireUser`, not `requireAdmin`.',
      recommendation: 'Mount the admin router behind `requireAdmin` and add a test for a non-admin user.',
      cwe: 'CWE-285',
      confidence: 'high',
      acceptanceCriteria: ['A non-admin gets 403 from every admin route'],
      touches: ['src/api/admin.ts'],
    },
    {
      title: `Session cookie lacks the Secure flag${suffix}`,
      severity: 'low',
      category: 'web',
      file: 'src/server.ts',
      line: 30,
      description: 'The session cookie can travel over plain HTTP when the app is reached without TLS.',
      details: '`cookie: { httpOnly: true, sameSite: "lax" }`',
      recommendation: 'Set `secure: true` outside development.',
      cwe: 'CWE-614',
      confidence: 'medium',
      acceptanceCriteria: ['The cookie has the Secure flag in production'],
      touches: ['src/server.ts'],
    },
  ];
  return `_Fake security audit from T3 Orchestra's fake agent (no real model read the code)._${block({
    summary: 'A small API with session auth. **One critical injection** in search and an authorization gap on the admin routes; the rest is hardening.',
    attackSurface: '- **Entry points:** `GET /api/search`, `/api/admin/*`, the sign-in form\n- **Sensitive data:** user accounts and sessions in SQLite\n- **Auth:** cookie sessions, roles in the users table',
    coverage: [
      { area: 'Auth & access control', status: 'issues', note: 'Admin routes miss the role check.' },
      { area: 'Injection & input', status: 'issues', note: 'One raw SQL string; the rest use the query builder.' },
      { area: 'Secrets & credentials', status: 'ok', note: 'Keys come from the environment.' },
      { area: 'AI & agents', status: 'not_applicable', note: 'No model calls.' },
    ],
    findings,
    resolved: resolved ? [resolved] : [],
  })}`;
}

function fakeImplementReply(blocked: boolean, pr: boolean): string {
  if (blocked) {
    return `I could not finish: the task needs a decision.${block({
      status: 'blocked',
      summary: 'Stopped before making changes.',
      blockedReason: 'The task title says "blocked" — the fake agent always blocks on its first run.',
    })}`;
  }
  return `Done.${block({
    status: 'done',
    tldr: pr ? 'Opened a pull request for this branch.' : 'Added a notes file from the fake agent. Nothing to check by hand.',
    summary: pr ? 'Pushed the branch and opened a pull request.' : 'Implemented the task in the fake agent and committed the change.',
    changes: ['Added fake-agent notes file'],
    testsRun: ['pnpm test → passed (fake)'],
    followUps: pr ? [] : ['Consider adding more tests for this area'],
  })}`;
}

/** Titles that sound risky get a high human-review score, everything else a low one. */
function fakeHumanReview(title: string) {
  return /auth|security|migration|payment|risky/i.test(title)
    ? { score: 8, reason: 'Touches a sensitive area; worth a careful look.' }
    : { score: 3, reason: 'Small, contained change covered by tests.' };
}

function fakeReviewReply(changes: boolean, num: number, title: string): string {
  if (!changes) return `Looks good.${block({ verdict: 'pass', summary: 'Implementation meets the acceptance criteria.', humanReview: fakeHumanReview(title), findings: [{ severity: 'nit', file: 'README.md', line: 1, title: 'Wording', detail: 'Could be clearer.', suggestion: 'Rephrase.' }] })}`;
  return `Found problems.${block({
    humanReview: fakeHumanReview(title),
    verdict: 'changes_requested',
    summary: `Task #${num} misses an edge case.`,
    findings: [
      { severity: 'major', file: 'src/index.ts', line: 42, title: 'Missing null check', detail: 'Crashes when input is empty.', suggestion: 'Guard the empty case.' },
      { severity: 'minor', file: 'src/index.ts', line: 50, title: 'Unclear name', detail: 'Variable `x` is vague.', suggestion: 'Rename to `count`.' },
    ],
  })}`;
}

function fakeInsightReply(question: string): string {
  const q = question.split(/\r?\n/)[0]!.slice(0, 120);
  return [
    `_Fake answer from T3 Orchestra's fake agent (no real model read the code)._ You asked: **${q}**`,
    '## Where to look',
    '- `README.md`: what the project does and how to run it\n- `src/index.ts:1`: the entry point, which wires the modules together',
    '## Answer',
    'The project is split into a small core and thin adapters around it:',
    '| Area | Files | Notes |\n|---|---|---|\n| Core | `src/core/` | Pure logic, unit-tested |\n| API | `src/api/` | HTTP handlers |\n| UI | `src/ui/` | Screens |',
    'A typical call goes through one function like this:',
    '```ts\nexport async function handle(req: Request): Promise<Response> {\n  const input = parse(await req.json());\n  return Response.json(await core.run(input));\n}\n```',
    '### Suggestions',
    '1. **Validate input at the API edge** (`src/api/`): reject bad bodies before they reach the core.\n2. **Add a smoke test** (`test/`): one request end to end catches wiring mistakes early.',
  ].join('\n\n');
}

/** What autoplay seeds into a project T3 Orchestra sees for the first time. */
const DEMO_HISTORY: HistoryItem[] = [
  {
    title: 'Set up the project skeleton',
    ask: 'Create a small web app: a Vite + React front end and a tiny Node API, with a README on how to run both.',
    reply: 'Done: `web/` (Vite + React) and `api/` (Node, one `/health` route). `pnpm dev` starts both. README covers setup.',
    daysAgo: 21,
  },
  {
    title: 'Add sign-in with email links',
    ask: 'Users should sign in with a magic link sent by email. No passwords.',
    reply: 'Sign-in works end to end with a console mailer in dev. Real email sending is still a TODO: it needs an SMTP provider.',
    daysAgo: 12,
  },
  {
    title: 'Fix flaky API tests',
    ask: 'The API tests fail about one run in five. Find out why.',
    reply: 'The tests shared one SQLite file. Each test now gets its own temp database; 50 runs in a row passed.',
    daysAgo: 6,
  },
  {
    title: 'Dashboard page with charts',
    ask: 'Add a dashboard page that shows sign-ups per day as a chart.',
    reply: 'Half done: the chart renders with fake data on the `dashboard` branch. The API endpoint for real numbers is not written yet.',
    daysAgo: 2,
    settled: false,
    branch: 'dashboard',
  },
  {
    title: 'Plan the billing feature',
    ask: 'How should we add paid plans? Just a plan, no code yet.',
    reply: 'Proposed Stripe Checkout with two plans and a webhook to store the subscription. Waiting on a decision about trial length.',
    daysAgo: 1,
    settled: false,
  },
];

function fakeImportReply(message: string): string {
  const threads = /## The project's threads \((\d+)/.exec(message)?.[1] ?? 'its';
  return `_Fake project context from T3 Orchestra's fake agent (no real model read the threads or the code)._${block({
    summary: `A small web app with email sign-in; a dashboard is half built and billing is being planned (read ${threads} threads).`,
    about:
      '**What it is:** a small web app with a Vite + React front end (`web/`) and a Node API (`api/`).\n\n**Run it:** `pnpm dev` starts both; tests run with `pnpm test`.\n\n**Layout:** `web/src/pages/` for screens, `api/src/routes/` for endpoints, SQLite for data.',
    state:
      '- **Done:** project skeleton, email-link sign-in (console mailer in dev), stable API tests (one temp DB per test).\n- **In progress:** the dashboard chart on branch `dashboard` uses fake data; the endpoint for real numbers is missing.\n- **Open decisions:** billing via Stripe Checkout is planned but the trial length is not decided.\n- **Known gaps:** no real email provider yet.',
    nextSteps: [
      'Write the sign-ups-per-day API endpoint and wire the dashboard to it',
      'Pick an SMTP provider and send real sign-in emails',
      'Decide the trial length, then build Stripe Checkout',
    ],
  })}`;
}

const FAKE_TYPE_HINTS: Array<[RegExp, string]> = [
  [/\?|open question|unclear|tbd/i, 'question'],
  [/decid|decision|chose|we use|picked/i, 'decision'],
  [/must not|never|limit|constraint|budget|deadline|gdpr|compliance/i, 'constraint'],
  [/must|should|require|needs? to/i, 'requirement'],
  [/stripe|github|slack|api key|webhook|third.party|integration|oauth/i, 'integration'],
  [/user|admin|customer|persona|role|team|owner/i, 'actor'],
  [/table|schema|field|record|data|model/i, 'data'],
  [/glossary|term|means|definition/i, 'term'],
  [/screen|page|flow|feature|dashboard|button/i, 'feature'],
];

/**
 * A knowledge graph build: one node per file and one per heading in it (text files only), typed by
 * keywords, each heading linked to its file, plus a link between consecutive headings.
 */
function fakeKnowledgeReply(message: string): string {
  const paths = [...message.matchAll(/^- `([^`]+)` \(/gm)].map((m) => m[1]!);
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const files: Array<Record<string, unknown>> = [];
  const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'node';
  for (const p of paths) {
    const name = path.basename(p);
    let text: string | null = null;
    try {
      const buf = fs.readFileSync(p);
      if (!buf.subarray(0, 4096).includes(0)) text = buf.toString('utf8');
    } catch {
      /* unreadable: skipped below */
    }
    if (text === null) {
      files.push({ file: name, summary: '', skipped: 'The fake agent reads text files only.' });
      continue;
    }
    const fileKey = keyOf(name.replace(/\.[^.]+$/, ''));
    const lines = text.split(/\r?\n/);
    const firstPara = lines.find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? `The file ${name}.`;
    nodes.push({ key: fileKey, name: name.replace(/\.[^.]+$/, ''), type: 'component', summary: firstPara.slice(0, 300), sources: [{ file: name, where: 'top', quote: firstPara.slice(0, 120) }] });
    const headings = lines.flatMap((l, i) => {
      const m = /^#{1,3}\s+(.+)$/.exec(l);
      return m ? [{ title: m[1]!.trim(), line: i }] : [];
    });
    let prev: string | null = null;
    for (const h of headings.slice(0, 15)) {
      const body = lines.slice(h.line + 1).find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? h.title;
      const key = keyOf(h.title);
      const type = FAKE_TYPE_HINTS.find(([re]) => re.test(`${h.title} ${body}`))?.[1] ?? 'feature';
      nodes.push({ key, name: h.title, type, summary: body.slice(0, 300), sources: [{ file: name, where: `line ${h.line + 1}`, quote: body.slice(0, 120) }] });
      edges.push({ from: key, to: fileKey, relation: 'part of', file: name });
      if (prev) edges.push({ from: prev, to: key, relation: 'relates to', file: name });
      prev = key;
    }
    files.push({ file: name, summary: `${headings.length} section(s)${headings.length ? `: ${headings.slice(0, 3).map((h) => h.title).join(', ')}` : ''}` });
  }
  const names = nodes.slice(0, 8).map((n) => `- **${String(n.name)}**`).join('\n');
  return `_Fake knowledge graph from T3 Orchestra's fake agent (no real model read the files)._${block({
    summary: `Read ${paths.length} file(s) into ${nodes.length} node(s).`,
    digest: `**Fake overview.** The context files cover:\n${names || '- (nothing readable)'}`,
    files,
    nodes,
    edges,
  })}`;
}

let fakeIdeaRounds = 0;

/** Each call gives new titles (repeats would be dropped as already proposed). */
function fakeIdeasReply(message: string): string {
  const focus = /## Focus: (.+)/.exec(message)?.[1]?.trim() ?? 'Ideas';
  const n = ++fakeIdeaRounds;
  const ideas = [
    { title: `Validate request bodies at the API edge`, impact: 'high', difficulty: 'easy', touches: ['src/api/'] },
    { title: `Cache the project summary between requests`, impact: 'medium', difficulty: 'medium', touches: ['src/core/cache.ts'] },
    { title: `Split the 600-line handler module`, impact: 'medium', difficulty: 'hard', touches: ['src/api/handlers.ts'] },
    { title: `Add an empty state to the list screen`, impact: 'low', difficulty: 'easy', touches: ['src/ui/List.tsx'] },
  ].map((i) => ({
    ...i,
    title: `${i.title}${n > 1 ? ` (${n})` : ''}`,
    description: `Fake ${focus.toLowerCase()} idea: ${i.title.toLowerCase()} so the common path is safer and easier to follow.`,
    details: `- Look at \`${i.touches[0]}\`\n- Keep the change small and covered by a test`,
    acceptanceCriteria: [`${i.title} is done`, 'Tests pass'],
  }));
  return `_Fake ideas from T3 Orchestra's fake agent (no real model read the code)._${block({ summary: `Looked for ${focus.toLowerCase()} in the core, the API and the UI.`, ideas })}`;
}

/** Marketing tasks of both kinds; like fakeIdeasReply, each call gives new titles. */
function fakeMarketingReply(message: string): string {
  const focus = /## Focus: (.+)/.exec(message)?.[1]?.trim() ?? 'Marketing';
  const n = ++fakeIdeaRounds;
  const suffix = n > 1 ? ` (${n})` : '';
  const ideas = [
    {
      kind: 'do',
      title: `Post a Show HN about the project${suffix}`,
      description: `Fake ${focus.toLowerCase()} task: introduce the project where developers look for new tools.`,
      details: '1. Post on a weekday morning (US time).\n2. Stay around for the first two hours to answer comments.',
      draft: 'Show HN: [Project] – [one line on what it does]\n\nHi HN, I built [Project] because [problem]. It [what it does].\n\nIt is [open source / free to try] at [link]. I would love feedback on [the part you are unsure about].',
      impact: 'high',
      difficulty: 'easy',
    },
    {
      kind: 'build',
      title: `Add Open Graph tags and a share image${suffix}`,
      description: `Fake ${focus.toLowerCase()} task: links to the site get a title, description and image when shared.`,
      details: '- Add `og:title`, `og:description` and `og:image` to the page head\n- Make a 1200x630 share image',
      acceptanceCriteria: ['Every page has og:title, og:description and og:image', 'The share image is 1200x630'],
      touches: ['src/ui/Head.tsx', 'public/og.png'],
      impact: 'medium',
      difficulty: 'easy',
    },
    {
      kind: 'do',
      title: `Write a launch thread for X and Bluesky${suffix}`,
      description: `Fake ${focus.toLowerCase()} task: a short thread that shows the main feature in action.`,
      details: 'Post the thread with a GIF of the main screen; pin it to the profile.',
      draft: '1/ We just shipped [Project]: [one line on what it does].\n\n2/ The problem: [problem].\n\n3/ How it works: [GIF]\n\n4/ Try it: [link]',
      impact: 'medium',
      difficulty: 'easy',
    },
    {
      kind: 'build',
      title: `Track sign-ups and the first core action${suffix}`,
      description: `Fake ${focus.toLowerCase()} task: know how many visitors become users.`,
      details: '- Fire `signed_up` after the account is created\n- Fire `first_project_created` once per user',
      acceptanceCriteria: ['Both events reach the analytics tool with the user id'],
      touches: ['src/api/auth.ts', 'src/core/projects.ts'],
      impact: 'high',
      difficulty: 'medium',
    },
  ];
  const needsBrief = /"suggestedBrief": "The brief you were asked to write above"/.test(message);
  const suggestedBrief = needsBrief
    ? '**[Project]** helps developers [do the main thing] without [the usual pain].\n\n- For: small teams shipping web apps\n- Why it wins: [the one thing it does better]'
    : '';
  return `_Fake marketing tasks from T3 Orchestra's fake agent (no real model read the code)._${block({ summary: `Looked at the README, the landing page and the sign-up flow for ${focus.toLowerCase()}.`, suggestedBrief, ideas })}`;
}

/** A spec round: three questions first, one follow-up after the first answers, then none. */
function fakeSpecReply(t: FakeThread, message: string): string {
  const goal = t.specGoal ?? 'the goal';
  const answers = [...message.matchAll(/^Q: (.+)\r?\nA: (.+)$/gm)].map((m) => `- ${m[1]!.trim()} → **${m[2]!.trim()}**`);
  t.specDecisions = [...(t.specDecisions ?? []), ...answers];
  const round = t.specRounds ?? 1;
  const questions =
    round === 1
      ? [
          {
            question: 'Who should be able to use this: every signed-in user, or admins only?',
            why: 'Admins only needs role checks and an admin screen: one or two more tasks.',
            options: ['Every signed-in user', 'Admins only', 'Both, with different views'],
            recommended: 'Every signed-in user',
          },
          {
            question: 'Should it work offline?',
            why: 'Offline needs local storage and a sync step, roughly two extra tasks.',
            options: ['No, online only', 'Read-only offline', 'Full offline with sync'],
            recommended: 'No, online only',
          },
          { question: 'Is there any part of the app this must not change?', why: 'Keeps the plan away from code you care about.', options: [], recommended: null },
        ]
      : round === 2
        ? [
            {
              question: 'Should the data people already have be migrated?',
              why: 'A migration is its own task and needs a rollback plan.',
              options: ['Migrate it', 'Start fresh'],
              recommended: 'Migrate it',
            },
          ]
        : [];
  const decisions = t.specDecisions.length ? t.specDecisions : ['- Build on the existing stack and conventions (assumed).'];
  const spec = [
    '## Goal',
    goal,
    '',
    '## Scope',
    `- **In:** what "${goal.split(/\r?\n/)[0]!.slice(0, 60)}" needs end to end: data, API and screens.`,
    '- **Out:** billing, i18n and a mobile app.',
    '',
    '## Behaviour',
    '1. A signed-in user opens the new page from the main menu.',
    '2. They create, edit and delete items; changes show up without a reload.',
    '3. Errors from the API show inline next to the form, never as a blank page.',
    '',
    '## Technical approach',
    '- New table and repository in `src/db/`, endpoints in `src/api/`, screens in `src/ui/`.',
    '- Reuse the existing auth middleware; no new dependencies.',
    '',
    '## Acceptance',
    '- A user can create an item and see it after a reload.',
    '- API tests cover create, edit, delete and the error cases.',
    '',
    '## Decisions',
    ...decisions,
    '',
    '## Risks and unknowns',
    round < 3 ? '- Waiting on the answers below.' : '- None known.',
  ].join('\n');
  const changes = round === 1 ? '' : answers.length ? `Worked in ${answers.length} ${answers.length === 1 ? 'answer' : 'answers'}.` : 'Updated after your note.';
  return `_Fake spec from T3 Orchestra's fake agent (no real model read the code)._${block({ spec, changes, questions })}`;
}

function fakePlanReply(message: string, runCount: number): string {
  const goal = /## GOAL\s*\n([\s\S]*?)(\n## |$)/.exec(message)?.[1]?.trim() ?? 'the goal';
  const short = goal.split(/\r?\n/)[0]!.slice(0, 50);
  const tasks = [
    { key: 'T1', title: `Scaffold module for ${short}`.slice(0, 110), category: 'infra', complexity: 'small', priority: 'high', dependsOn: [], touches: ['src/core/'] },
    { key: 'T2', title: 'Add data model and storage', category: 'feature', complexity: 'medium', priority: 'high', dependsOn: ['T1'], touches: ['src/db/'] },
    { key: 'T3', title: 'Build the API endpoints', category: 'feature', complexity: 'medium', priority: 'medium', dependsOn: ['T2'], touches: ['src/api/'] },
    { key: 'T4', title: 'Create the UI screens', category: 'design', complexity: 'medium', priority: 'medium', dependsOn: ['T1'], touches: ['src/ui/'] },
    { key: 'T5', title: 'Write integration tests', category: 'test', complexity: 'small', priority: 'low', dependsOn: ['T3', 'T4'], touches: ['test/'] },
    { key: 'T6', title: 'Document usage in README', category: 'docs', complexity: 'trivial', priority: 'low', dependsOn: [], touches: ['README.md'] },
  ].map((t) => ({
    ...t,
    description: `Fake planner task for: ${short}`,
    acceptanceCriteria: [`${t.title} works`, 'Tests pass'],
    milestone: ['T1', 'T2', 'T3'].includes(t.key) ? 'Core works end to end' : 'Ready to ship',
  }));
  if (runCount > 1 && !/could not be used/.test(message)) {
    tasks.push({ key: 'T7', title: 'Address refinement feedback', category: 'refactor', complexity: 'small', priority: 'medium', dependsOn: ['T2'], touches: ['src/'], description: 'Added after refinement.', acceptanceCriteria: ['Feedback addressed'], milestone: 'Core works end to end' });
  }
  return `Here is the plan.${block({
    summary: `Split "${short}" into scaffolding, data, API, UI, tests and docs.`,
    assumptions: ['The repo uses TypeScript'],
    openQuestions: ['Should the UI support dark mode?'],
    milestones: [
      { title: 'Core works end to end', goal: 'Data is stored and served by the API' },
      { title: 'Ready to ship', goal: 'Screens, tests and docs are done' },
    ],
    tasks,
  })}`;
}
