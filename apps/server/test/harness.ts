// Test harness: in-memory DB, scripted FakeT3Client, temp git repo; loops are driven by hand.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/client.ts';
import { notifications, runs, tasks } from '../src/db/schema.ts';
import { taskView } from '../src/db/views.ts';
import { createBoard } from '../src/engine/boards.ts';
import { Engine } from '../src/engine/engine.ts';
import { createTask } from '../src/engine/tasks.ts';
import { FakeT3Client } from '../src/t3/FakeT3Client.ts';
import type { CreateBoardBody, CreateTaskBody } from '@t3-orchestra/shared';

export const fence = (obj: unknown) => `Done.\n\n\`\`\`t3orchestra-result\n${JSON.stringify(obj)}\n\`\`\``;
export const implDone = (summary = 'did it') => fence({ status: 'done', summary, followUps: ['more tests'] });
export const reviewPass = (score?: number) =>
  fence({ verdict: 'pass', summary: 'ok', findings: [], ...(score === undefined ? {} : { humanReview: { score, reason: `scored ${score}` } }) });
export const reviewChanges = (severity = 'major') =>
  fence({ verdict: 'changes_requested', summary: 'bad', findings: [{ severity, file: 'a.ts', line: 1, title: 'Bug', detail: 'broken', suggestion: 'fix' }] });

export async function gitRepo(dir: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => execa('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  await execa('git', ['init', '-b', 'main', dir]);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  await g('add', '.');
  await g('commit', '-m', 'init');
  return dir;
}

export async function setup(o: { board?: Partial<CreateBoardBody> } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't3orchestra-test-'));
  const repo = await gitRepo(path.join(tmp, 'repo'));
  const fake = new FakeT3Client({ autoplay: false });
  const db = openDb(':memory:');
  const config = loadConfig({ dataDir: tmp, fakeT3: true, promptsOverrideDir: path.join(tmp, 'prompts') });
  const engine = new Engine({ db, t3: fake, config, desktop: null, healthIntervalMs: 1e9 });
  const ctx = engine.ctx;
  ctx.kick = () => {}; // tests drive the scheduler explicitly
  await ctx.health.check();
  const board = await createBoard(ctx, { name: 'Test Board', projectPath: repo, ...o.board });

  const h = {
    tmp,
    repo,
    fake,
    db,
    engine,
    ctx,
    board,
    newTask(body: Partial<CreateTaskBody> & { title: string }) {
      return createTask(ctx, board.id, {
        description: '',
        acceptanceCriteria: ['works'],
        dependsOn: [],
        complexity: 'medium',
        category: 'feature',
        priority: 'medium',
        touches: [],
        providerOverride: null,
        modelOverride: null,
        skipAiReview: false,
        milestoneId: null,
        ...body,
      });
    },
    task(id: string) {
      return db.select().from(tasks).where(eq(tasks.id, id)).get()!;
    },
    view(id: string) {
      return taskView(db, id, { staleAfterMinutes: 15 })!;
    },
    runsOf(taskId: string) {
      return db.select().from(runs).where(eq(runs.taskId, taskId)).all();
    },
    openRun(taskId: string) {
      return db
        .select()
        .from(runs)
        .where(eq(runs.taskId, taskId))
        .all()
        .filter((r) => ['starting', 'active', 'waiting'].includes(r.status))
        .at(-1);
    },
    notifications() {
      return db.select().from(notifications).all();
    },
    tick: () => engine.reconciler.tick(),
    /** Finishes the open run of a task (on whatever thread it uses) and reconciles. */
    async finish(taskId: string, text: string, status = 'completed') {
      const run = h.openRun(taskId);
      if (!run?.threadId) throw new Error(`task has no open run with a thread (runs: ${JSON.stringify(h.runsOf(taskId).map((r) => [r.kind, r.status]))})`);
      fake.setStatus(run.threadId, 'running');
      await h.tick();
      fake.finishRun(run.threadId, text, status);
      await h.tick();
    },
    cleanup() {
      engine.stop();
      fake.dispose();
      db.$client.close();
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    },
  };
  return h;
}

export type Harness = Awaited<ReturnType<typeof setup>>;
