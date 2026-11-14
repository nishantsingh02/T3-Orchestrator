// Wires the engine together and owns the background loops.
import type { DiffView } from '@t3-orchestra/shared';
import { eq } from 'drizzle-orm';
import { Bus } from '../bus.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { boards, tasks } from '../db/schema.ts';
import * as git from '../git/git.ts';
import { childLog } from '../log.ts';
import { Notifier, type DesktopSink } from '../notify/notifier.ts';
import { MarketingRefresher } from '../marketing/service.ts';
import { ProjectRunManager } from '../project-run/manager.ts';
import { recoverScans, SecurityRefresher } from '../security/service.ts';
import { SettingsStore } from '../settings.ts';
import { HealthMonitor } from '../t3/health.ts';
import type { T3Client } from '../t3/T3Client.ts';
import { BackgroundWatch } from './background.ts';
import { AppError, getTaskOrThrow, type EngineContext } from './context.ts';
import { resumeGathering } from './imports.ts';
import { PromptStore } from './prompts.ts';
import { Reconciler } from './reconciler.ts';
import { Scheduler } from './scheduler.ts';

const log = childLog('engine');

/** Larger patches are cut at a file boundary; the file list stays complete. */
const MAX_PATCH_CHARS = 3_000_000;

export interface EngineOptions {
  db: Db;
  t3: T3Client;
  config: Config;
  desktop?: DesktopSink | null;
  /** Health check interval (tests use a long one and call check() themselves). */
  healthIntervalMs?: number;
  fetch?: typeof fetch;
}

export class Engine {
  readonly ctx: EngineContext;
  readonly reconciler: Reconciler;
  readonly scheduler: Scheduler;
  /** "Run project" processes (not agent runs). */
  readonly projectRuns: ProjectRunManager;
  /** Background refresh of marketing metrics. */
  readonly marketing: MarketingRefresher;
  /** Background secret and dependency scans (boards with auto-scan on). */
  readonly security: SecurityRefresher;
  private t3DownTimer: NodeJS.Timeout | null = null;
  private kickTimer: NodeJS.Timeout | null = null;

  constructor(o: EngineOptions) {
    const bus = new Bus();
    const settings = new SettingsStore(o.db);
    const notifier = new Notifier(o.db, bus, settings, () => o.config.publicUrl, o.desktop ?? null);
    const health = new HealthMonitor(o.t3, bus, o.healthIntervalMs ?? 10_000, (h) => this.onHealthChange(h.cliFound && h.serverReachable));
    this.ctx = {
      db: o.db,
      t3: o.t3,
      bus,
      settings,
      notifier,
      health,
      prompts: new PromptStore(o.config.promptsOverrideDir),
      config: o.config,
      kick: () => this.kick(),
      fetch: o.fetch ?? globalThis.fetch,
      background: new BackgroundWatch(o.t3),
    };
    this.scheduler = new Scheduler(this.ctx);
    this.reconciler = new Reconciler(this.ctx, () => this.scheduler.run());
    this.projectRuns = new ProjectRunManager({ bus, dataDir: o.config.dataDir });
    this.marketing = new MarketingRefresher(this.ctx);
    this.security = new SecurityRefresher(this.ctx);
    settings.onChange((s) => bus.emit('settings', s));
  }

  /** Boot order (spec §8 "Startup"): health, then reconcile (incl. orphan recovery), then scheduler. */
  async start(): Promise<void> {
    this.projectRuns.cleanupOrphans();
    this.projectRuns.restoreBackground();
    await this.ctx.health.check();
    this.ctx.health.start();
    await this.reconciler.tick();
    this.reconciler.start();
    resumeGathering(this.ctx);
    recoverScans(this.ctx);
    this.marketing.start();
    this.security.start();
    log.info({ healthy: this.ctx.health.healthy() }, 'engine started');
  }

  stop(): void {
    this.projectRuns.stopAll();
    this.reconciler.stop();
    this.marketing.stop();
    this.security.stop();
    this.ctx.health.stop();
    if (this.t3DownTimer) clearTimeout(this.t3DownTimer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
  }

  /** Coalesced "something changed": schedule soon and reconcile soon. */
  kick(): void {
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.scheduler.run();
      this.reconciler.poke();
    }, 50);
  }

  private onHealthChange(ok: boolean): void {
    if (ok) {
      if (this.t3DownTimer) clearTimeout(this.t3DownTimer);
      this.t3DownTimer = null;
      this.ctx.kick();
      return;
    }
    if (this.t3DownTimer) return;
    this.t3DownTimer = setTimeout(() => {
      this.t3DownTimer = null;
      if (this.ctx.health.healthy()) return;
      const downSince = this.ctx.health.downSince ?? Date.now();
      for (const b of this.ctx.db.select().from(boards).all()) {
        if (b.archivedAt) continue;
        this.ctx.notifier.notify({
          type: 't3_down',
          boardId: b.id,
          dedupe: String(downSince),
          title: 'T3 Code is not reachable; auto-run paused',
          body: 'Start the T3 app to continue.',
        });
        break; // one toast is enough
      }
    }, 60_000);
  }

  async diff(taskId: string, full: boolean): Promise<DiffView> {
    const task = getTaskOrThrow(this.ctx, taskId);
    const board = this.ctx.db.select().from(boards).where(eq(boards.id, task.boardId)).get()!;
    const base = board.baseBranch;
    if (!task.worktreePath || !task.branch) {
      return { base, head: null, branch: task.branch, behindBy: 0, uncommitted: [], files: [], patch: full ? '' : undefined };
    }
    try {
      const [files, uncommitted, head, behindBy] = await Promise.all([
        git.diffFiles(task.worktreePath, base),
        git.uncommitted(task.worktreePath),
        git.headSha(task.worktreePath),
        git.behindBy(board.projectPath, base, task.branch),
      ]);
      let patch = full ? await git.diffPatch(task.worktreePath, base) : undefined;
      const truncated = patch !== undefined && patch.length > MAX_PATCH_CHARS;
      if (patch !== undefined && truncated) {
        const lastFileStart = patch.lastIndexOf('\ndiff --git ', MAX_PATCH_CHARS);
        patch = patch.slice(0, lastFileStart > 0 ? lastFileStart + 1 : MAX_PATCH_CHARS);
      }
      const stat = git.summarize(files);
      this.ctx.db.update(tasks).set({ diffStat: stat }).where(eq(tasks.id, taskId)).run();
      return { base, head, branch: task.branch, behindBy, uncommitted, files, patch, truncated };
    } catch (err) {
      throw new AppError('GIT_ERROR', `Could not read the worktree ${task.worktreePath}: ${(err as Error).message}`, 500);
    }
  }
}
