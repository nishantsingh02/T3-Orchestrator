import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { eq } from 'drizzle-orm';
import * as git from '../src/git/git.ts';
import { tasks } from '../src/db/schema.ts';
import { runAction } from '../src/engine/actions.ts';
import { gitRepo, implDone, reviewPass, setup, type Harness } from './harness.ts';

const g = (dir: string, ...a: string[]) => execa('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);

async function commitFile(dir: string, file: string, content: string, msg = `edit ${file}`) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  await g(dir, 'add', '-A');
  await g(dir, 'commit', '-m', msg);
}

describe('git helpers', () => {
  let tmp: string;
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));

  it('diff stat, uncommitted, behind-by, merge and conflict-abort', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't3orchestra-git-'));
    const root = await gitRepo(path.join(tmp, 'repo'));
    const wt = path.join(tmp, 'wt');
    await g(root, 'worktree', 'add', '-b', 'feature', wt, 'main');

    await commitFile(wt, 'src/a.ts', 'one\ntwo\n');
    const files = await git.diffFiles(wt, 'main');
    expect(files).toEqual([{ path: 'src/a.ts', added: 2, removed: 0, binary: false }]);
    expect(git.summarize(files)).toEqual({ added: 2, removed: 0, files: 1 });
    expect(await git.diffPatch(wt, 'main')).toContain('+one');

    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'x');
    expect(await git.uncommitted(wt)).toEqual(['scratch.txt']);
    expect(await git.trackedChanges(wt)).toEqual([]);
    fs.rmSync(path.join(wt, 'scratch.txt'));

    await commitFile(root, 'other.md', 'x');
    expect(await git.behindBy(root, 'main', 'feature')).toBe(1);

    const ok = await git.mergeNoFf(root, 'feature', '#1 feature (T3 Orchestra)');
    expect(ok.ok).toBe(true);
    const log = (await g(root, 'log', '-1', '--format=%s')).stdout;
    expect(log).toBe('#1 feature (T3 Orchestra)');

    // conflict: both sides edit the same line
    await g(root, 'worktree', 'add', '-b', 'clash', path.join(tmp, 'wt2'), 'main');
    await commitFile(path.join(tmp, 'wt2'), 'README.md', 'theirs\n');
    await commitFile(root, 'README.md', 'ours\n');
    const conflict = await git.mergeNoFf(root, 'clash', 'merge clash');
    expect(conflict).toEqual({ ok: false, conflict: true, files: ['README.md'] });
    expect(await git.refExists(root, 'MERGE_HEAD')).toBe(false); // aborted
    expect(await git.trackedChanges(root)).toEqual([]);
    expect(await git.currentBranch(root)).toBe('main');
  });
});

describe('approve with the local merge strategy (spec §13)', () => {
  let h: Harness;
  afterEach(() => h?.cleanup());

  async function reviewedTask(title: string, file: string, content: string) {
    const t = h.newTask({ title, complexity: 'trivial' });
    await runAction(h.ctx, t.id, 'start', {});
    const task = h.task(t.id);
    const wt = path.join(h.tmp, `wt-${task.number}`);
    await g(h.repo, 'worktree', 'add', '-b', task.branch!, wt, 'main');
    await commitFile(wt, file, content, `#${task.number}: work`);
    h.db.update(tasks).set({ worktreePath: wt }).where(eq(tasks.id, t.id)).run();
    h.fake.get(task.threadId!).detail.worktreePath = wt; // T3 reports the worktree
    await h.finish(t.id, implDone());
    expect(h.task(t.id).stage).toBe('human_review');
    return { id: t.id, wt };
  }

  it('merges into the base branch and marks the task done', async () => {
    h = await setup();
    const { id } = await reviewedTask('Add a', 'a.txt', 'a\n');
    expect(h.view(id).diffStat).toEqual({ added: 1, removed: 0, files: 1 });
    await runAction(h.ctx, id, 'approve', {});
    expect(h.task(id).stage).toBe('done');
    expect((await g(h.repo, 'log', '-1', '--format=%s')).stdout).toBe('#1 Add a (T3 Orchestra)');
    expect(fs.readFileSync(path.join(h.repo, 'a.txt'), 'utf8').trim()).toBe('a'); // autocrlf-safe
  });

  it('refuses a dirty worktree, a dirty root, and a root on another branch', async () => {
    h = await setup();
    const { id, wt } = await reviewedTask('Add b', 'b.txt', 'b\n');
    fs.writeFileSync(path.join(wt, 'left.txt'), 'oops');
    await expect(runAction(h.ctx, id, 'approve', {})).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });
    fs.rmSync(path.join(wt, 'left.txt'));

    fs.writeFileSync(path.join(h.repo, 'README.md'), 'local edit\n');
    await expect(runAction(h.ctx, id, 'approve', {})).rejects.toMatchObject({ code: 'DIRTY_ROOT' });
    await g(h.repo, 'checkout', '--', 'README.md');

    await g(h.repo, 'checkout', '-b', 'elsewhere');
    await expect(runAction(h.ctx, id, 'approve', {})).rejects.toMatchObject({ code: 'DIRTY_ROOT' });
    await g(h.repo, 'checkout', 'main');

    // Untracked files in the root don't block.
    fs.writeFileSync(path.join(h.repo, 'notes.local'), 'x');
    await runAction(h.ctx, id, 'approve', {});
    expect(h.task(id).stage).toBe('done');
  });

  it('merges while the context folder the board writes has uncommitted changes', async () => {
    h = await setup();
    await commitFile(h.repo, '.t3orchestra/context/graph.json', '{}\n', 'context');
    const { id } = await reviewedTask('Add c', 'c.txt', 'c\n');
    fs.writeFileSync(path.join(h.repo, '.t3orchestra', 'context', 'graph.json'), '{"changed":true}\n');
    await runAction(h.ctx, id, 'approve', {});
    expect(h.task(id).stage).toBe('done');
    expect(fs.readFileSync(path.join(h.repo, '.t3orchestra', 'context', 'graph.json'), 'utf8')).toContain('changed');
  });

  it('refuses to "merge" a branch with no commits', async () => {
    h = await setup();
    const t = h.newTask({ title: 'Nothing', complexity: 'trivial' });
    await runAction(h.ctx, t.id, 'start', {});
    const task = h.task(t.id);
    const wt = path.join(h.tmp, 'wt-empty');
    await g(h.repo, 'worktree', 'add', '-b', task.branch!, wt, 'main');
    h.fake.get(task.threadId!).detail.worktreePath = wt;
    await h.finish(t.id, implDone());
    await expect(runAction(h.ctx, t.id, 'approve', {})).rejects.toMatchObject({ code: 'NOTHING_TO_MERGE' });
    expect(h.task(t.id).stage).toBe('human_review');
  });

  it('a conflict aborts, sets merge_conflict and offers Update branch', async () => {
    h = await setup();
    const { id } = await reviewedTask('Edit readme', 'README.md', 'from the task\n');
    await commitFile(h.repo, 'README.md', 'from main\n');
    await expect(runAction(h.ctx, id, 'approve', {})).rejects.toMatchObject({ code: 'MERGE_CONFLICT' });
    expect(h.task(id)).toMatchObject({ stage: 'human_review', stageReason: 'merge_conflict' });
    expect(await git.refExists(h.repo, 'MERGE_HEAD')).toBe(false);

    const diff = await h.engine.diff(id, false);
    expect(diff.behindBy).toBe(1);

    await runAction(h.ctx, id, 'update-branch', {});
    expect(h.task(id).stage).toBe('implementing');
    const sent = h.fake.calls.filter((c) => c.op === 'send').at(-1)!.args as { message: string };
    expect(sent.message).toContain('`main` has moved since you started');
  });
});

describe("auto-approve: AI review score under the board's limit", () => {
  let h: Harness;
  afterEach(() => h?.cleanup());

  /** A task with one commit in its own worktree, finished and waiting in AI review. */
  async function builtTask(title: string, file: string, dependsOn: string[] = []) {
    const t = h.newTask({ title, dependsOn });
    await runAction(h.ctx, t.id, 'start', { force: true });
    const task = h.task(t.id);
    const wt = path.join(h.tmp, `wt-${task.number}`);
    await g(h.repo, 'worktree', 'add', '-b', task.branch!, wt, 'main');
    await commitFile(wt, file, `${title}\n`, `#${task.number}: work`);
    h.fake.get(task.threadId!).detail.worktreePath = wt;
    await h.finish(t.id, implDone());
    expect(h.task(t.id).stage).toBe('ai_review');
    return t.id;
  }
  const reviewNotes = (id: string) => h.notifications().filter((n) => n.type === 'human_review' && n.taskId === id);

  it('merges a task scored under the limit without the user, and its dependents start', async () => {
    h = await setup({ board: { autoApproveBelow: 6, autoRun: true } });
    const a = await builtTask('Add a', 'a.txt');
    const b = h.newTask({ title: 'Use a', dependsOn: [a] });
    await runAction(h.ctx, b.id, 'move-to-ready', {});

    await h.finish(a, reviewPass(5));
    expect(h.task(a)).toMatchObject({ stage: 'done', stageReason: 'auto_approved', reviewScore: 5, reviewScoreReason: 'scored 5' });
    expect(h.view(a).diffStat).toEqual({ added: 1, removed: 0, files: 1 });
    expect((await g(h.repo, 'log', '-1', '--format=%s')).stdout).toBe('#1 Add a (T3 Orchestra)');
    expect(reviewNotes(a)).toEqual([]);
    const ev = h.db.$client.prepare("SELECT payload FROM events WHERE task_id = ? AND payload LIKE '%auto.approve%'").get(a) as { payload: string };
    expect(JSON.parse(ev.payload)).toMatchObject({ event: 'auto.approve', actor: 'reconciler', score: 5, below: 6 });

    await h.engine.scheduler.run();
    expect(h.task(b.id).stage).toBe('implementing');
  });

  it('a score at the limit, no score, or auto-approve off waits for the user', async () => {
    h = await setup({ board: { autoApproveBelow: 6 } });
    const atLimit = await builtTask('Six', 'six.txt');
    await h.finish(atLimit, reviewPass(6));
    expect(h.task(atLimit)).toMatchObject({ stage: 'human_review', stageReason: 'ai_passed', reviewScore: 6 });
    expect(reviewNotes(atLimit)).toHaveLength(1);

    const unscored = await builtTask('Unscored', 'none.txt');
    await h.finish(unscored, reviewPass());
    expect(h.task(unscored)).toMatchObject({ stage: 'human_review', reviewScore: null });

    h.db.$client.prepare('UPDATE boards SET auto_approve_below = NULL').run();
    const off = await builtTask('Off', 'off.txt');
    await h.finish(off, reviewPass(1));
    expect(h.task(off)).toMatchObject({ stage: 'human_review', reviewScore: 1 });

    // Changing the code again drops the old score; the next review gives a new one.
    await runAction(h.ctx, off, 'request-changes', { text: 'rename it' });
    expect(h.task(off)).toMatchObject({ stage: 'implementing', reviewScore: null, reviewScoreReason: null });
  });

  it('a failed auto-approve leaves the task with the user and says why', async () => {
    h = await setup({ board: { autoApproveBelow: 6 } });
    const id = await builtTask('Add c', 'c.txt');
    fs.writeFileSync(path.join(h.repo, 'README.md'), 'local edit\n'); // dirty root checkout
    await h.finish(id, reviewPass(2));
    expect(h.task(id)).toMatchObject({ stage: 'human_review', stageReason: 'ai_passed', reviewScore: 2 });
    const failed = h.db.$client.prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'auto_approve_failed'").get(id) as { payload: string };
    expect(JSON.parse(failed.payload)).toMatchObject({ score: 2, below: 6, message: expect.stringContaining('uncommitted') });
    expect(reviewNotes(id).map((n) => n.title)).toEqual(['#1 ready for review (AI passed 2/10, auto-approve failed)']);
  });
});
