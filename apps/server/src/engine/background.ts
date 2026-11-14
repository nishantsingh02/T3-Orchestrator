// Background work an agent left running when its turn ended (a long test run, sub-agents, …). T3
// resumes the thread by itself when that work reports back, so such a turn is not the end of the run:
// the reconciler keeps the run open until the agent's real last turn.
import type { RunRow } from '../db/schema.ts';
import { childLog } from '../log.ts';
import { holdingWork, type BackgroundTask, type T3Client, type ThreadDetail } from '../t3/T3Client.ts';
import { errorMessage } from '../util.ts';

const log = childLog('background');

/** How often a waiting run's work is read again while its thread shows no change. */
export const BACKGROUND_RECHECK_MS = 30_000;
/** After the work is done, how long T3 gets to resume the agent before the run ends without it. */
export const BACKGROUND_GRACE_MS = 15_000;

interface Hold {
  work: BackgroundTask[];
  /** The thread state the work was read for. */
  key: string;
  checkedAt: number;
  /** When T3 stopped listing the work while the thread had not moved on yet. */
  endedAt: number | null;
}

const recheckAfter = (h: Hold) => (h.endedAt === null ? BACKGROUND_RECHECK_MS : BACKGROUND_GRACE_MS);

export class BackgroundWatch {
  /** Open runs whose finished turn waits on background work, by run id. */
  private readonly holds = new Map<string, Hold>();
  /** One read of T3 per reconcile pass, shared by every run that needs it. */
  private lookup: Promise<Map<string, BackgroundTask[]>> | null = null;

  constructor(
    private readonly t3: T3Client,
    private readonly now: () => number = Date.now,
  ) {}

  /** At the start of each reconcile pass: later reads go to T3 again, closed runs are forgotten. */
  newPass(openRunIds: ReadonlySet<string>): void {
    this.lookup = null;
    for (const id of this.holds.keys()) if (!openRunIds.has(id)) this.holds.delete(id);
  }

  /** A waiting run whose thread should be read again although it shows no change. */
  due(runId: string): boolean {
    const h = this.holds.get(runId);
    return !!h && this.now() - h.checkedAt >= recheckAfter(h);
  }

  /** What the run waits on (empty when it is not waiting). */
  workOf(runId: string): BackgroundTask[] {
    return this.holds.get(runId)?.work ?? [];
  }

  /** The thread is busy again: the run no longer waits. True when it was waiting. */
  release(runId: string): boolean {
    return this.holds.delete(runId);
  }

  /**
   * The background work that keeps the run's finished turn open (empty: the run is over), and whether
   * that differs from last time. When T3 cannot be read, a run already waiting keeps waiting and
   * tries again later; any other run ends as before.
   */
  async holding(run: RunRow, thread: ThreadDetail): Promise<{ work: BackgroundTask[]; changed: boolean }> {
    const key = `${thread.latestRunId}|${thread.updatedAt}`;
    const now = this.now();
    const prev = this.holds.get(run.id);
    if (prev && prev.key === key && now - prev.checkedAt < recheckAfter(prev)) return { work: prev.work, changed: false };
    let all: Map<string, BackgroundTask[]>;
    try {
      all = await (this.lookup ??= this.t3.backgroundWork());
    } catch (err) {
      log.warn({ runId: run.id, err: errorMessage(err) }, 'could not read background work');
      if (!prev) return { work: [], changed: false };
      prev.checkedAt = now;
      return { work: prev.work, changed: false };
    }
    const work = holdingWork(all.get(thread.threadId) ?? []);
    if (!work.length && prev?.key === key && (prev.endedAt === null || now - prev.endedAt < BACKGROUND_GRACE_MS)) {
      // Done, but T3 starts the agent's next turn a moment after it stops listing the work.
      prev.endedAt ??= now;
      prev.checkedAt = now;
      return { work: prev.work, changed: false };
    }
    const ids = (w: BackgroundTask[]) => w.map((t) => t.taskId).join('\n');
    const changed = ids(work) !== ids(prev?.work ?? []);
    if (work.length) this.holds.set(run.id, { work, key, checkedAt: now, endedAt: null });
    else this.holds.delete(run.id);
    if (changed) log.info({ runId: run.id, work: work.map(backgroundLabel) }, work.length ? 'turn ended; waiting on background work' : 'background work done');
    return { work, changed };
  }
}

/** "Run the full integration suite", or the kind when the agent gave no description. */
export function backgroundLabel(t: BackgroundTask): string {
  return t.description ?? (t.kind === 'subagent' ? 'a sub-agent' : t.kind === 'command' ? 'a command' : 'background work');
}
