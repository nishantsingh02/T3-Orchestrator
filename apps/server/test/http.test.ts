import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { events, runs } from '../src/db/schema.ts';
import { screenshotDir } from '../src/engine/screenshots.ts';
import { createApp } from '../src/http/app.ts';
import { setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

const PORT = 4417;
const HOST = { host: `127.0.0.1:${PORT}` };

function client() {
  const app = createApp({ engine: h.engine, port: PORT });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...HOST, 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'x-t3orchestra': '1' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { app, call };
}

describe('HTTP API', () => {
  it('rejects foreign hosts (DNS rebinding guard)', async () => {
    h = await setup();
    const { app } = client();
    expect((await app.request('/api/health', { headers: { host: 'evil.example:4417' } })).status).toBe(403);
    expect((await app.request('/api/health', { headers: { host: `localhost:${PORT}` } })).status).toBe(200);
  });

  it('requires X-T3Orchestra on mutating requests (CSRF guard)', async () => {
    h = await setup();
    const { call } = client();
    const res = await call('POST', `/api/boards/${h.board.id}/tasks`, { title: 'x' }, { 'x-t3orchestra': '' });
    expect(res.status).toBe(403);
  });

  it('creates and lists tasks, runs actions, reports errors in the documented shape', async () => {
    h = await setup();
    const { call } = client();
    const board = await call('GET', `/api/boards/${h.board.slug}`);
    expect(board.status).toBe(200);
    expect(board.json.slug).toBe(h.board.slug);

    const created = await call('POST', `/api/boards/${h.board.id}/tasks`, { title: 'First', acceptanceCriteria: ['a'] });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ number: 1, stage: 'backlog', column: 'backlog' });

    const bad = await call('POST', `/api/boards/${h.board.id}/tasks`, { title: '' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('VALIDATION');

    const illegal = await call('POST', `/api/tasks/${created.json.id}/actions/mark-done`, {});
    expect(illegal.status).toBe(409);
    expect(illegal.json).toMatchObject({ ok: false, error: { code: 'ILLEGAL_TRANSITION' } });

    const moved = await call('POST', `/api/tasks/${created.json.id}/actions/move-to-ready`, {});
    expect(moved.json).toMatchObject({ ok: true, task: { stage: 'ready' } });

    const started = await call('POST', `/api/tasks/${created.json.id}/actions/start`, {});
    expect(started.json.task.stage).toBe('implementing');
    expect(started.json.task.activeRun.kind).toBe('implement');

    const list = await call('GET', `/api/boards/${h.board.id}/tasks`);
    expect(list.json).toHaveLength(1);
    const detail = await call('GET', `/api/tasks/${created.json.id}`);
    expect(detail.json.runs).toHaveLength(1);
    expect(detail.json.events.length).toBeGreaterThan(1);

    const unknown = await call('POST', `/api/tasks/${created.json.id}/actions/explode`, {});
    expect(unknown.status).toBe(404);
  });

  it('adds each follow-up suggestion as one task until that task is discarded', async () => {
    h = await setup();
    const { call } = client();
    const parent = h.newTask({ title: 'Parent' });

    const added = await call('POST', `/api/tasks/${parent.id}/follow-ups`, { text: ' more tests ' });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ followUpOf: parent.id, followUpText: 'more tests', title: 'more tests', stage: 'backlog' });

    const again = await call('POST', `/api/tasks/${parent.id}/follow-ups`, { text: 'more tests' });
    expect(again.status).toBe(409);
    expect(again.json.error.message).toContain(`#${added.json.number}`);

    await call('POST', `/api/tasks/${added.json.id}/actions/discard`, {});
    const readded = await call('POST', `/api/tasks/${parent.id}/follow-ups`, { text: 'more tests' });
    expect(readded.status).toBe(201);
  });

  it('lists and serves screenshots from the task folder only', async () => {
    h = await setup();
    const { app, call } = client();
    const task = h.newTask({ title: 'UI change' });
    await call('POST', `/api/tasks/${task.id}/actions/move-to-ready`, {});
    await call('POST', `/api/tasks/${task.id}/actions/start`, {});
    const dir = screenshotDir(h.ctx.config.dataDir, h.task(task.id));
    expect(h.openRun(task.id)!.promptText).toContain(dir);

    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'main screen.png'), png);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an image');
    fs.writeFileSync(path.join(h.ctx.config.dataDir, 'outside.png'), png);

    const detail = await call('GET', `/api/tasks/${task.id}`);
    expect(detail.json.screenshots).toEqual([
      { name: 'main screen.png', url: expect.stringMatching(/^\/api\/tasks\/[^/]+\/screenshots\/main%20screen\.png\?v=\d+$/) },
    ]);
    const img = await app.request(detail.json.screenshots[0].url, { headers: HOST });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer())).toEqual(png);

    for (const name of ['notes.txt', 'missing.png', '..%2F..%2F..%2Foutside.png', '..%5C..%5C..%5Coutside.png']) {
      const res = await app.request(`/api/tasks/${task.id}/screenshots/${name}`, { headers: HOST });
      expect(res.status, name).toBe(404);
    }
  });

  it('reports board stats: agent time per run kind and waits for the user', async () => {
    h = await setup();
    const { call } = client();
    const task = h.newTask({ title: 'Stats' });
    const t0 = Date.parse('2026-11-05T10:00:00Z');
    const iso = (min: number) => new Date(t0 + min * 60_000).toISOString();
    const run = (id: string, kind: 'implement' | 'review', status: 'completed' | 'failed' | 'active', from: number, to: number | null) =>
      h.db.insert(runs).values({ id, boardId: h.board.id, taskId: task.id, kind, threadRole: kind === 'review' ? 'review' : 'task', status, promptText: '', startedAt: iso(from), finishedAt: to === null ? null : iso(to) }).run();
    run('r1', 'implement', 'completed', 0, 30);
    run('r2', 'implement', 'failed', 40, 50);
    run('r3', 'review', 'completed', 30, 35);
    run('r4', 'implement', 'active', 60, null);
    const ev = (min: number, type: string, payload: Record<string, unknown> = {}) =>
      h.db.insert(events).values({ boardId: h.board.id, taskId: task.id, type, payload, createdAt: iso(min) }).run();
    const stage = (min: number, event: string, from: string, to: string, reason: string | null = null) => ev(min, 'stage_changed', { event, from, to, reason });
    ev(5, 'attention_set', { attention: 'question' });
    ev(9, 'attention_cleared');
    stage(35, 'review.pass', 'ai_review', 'human_review');
    stage(95, 'user.approve', 'human_review', 'human_review', 'merge_conflict');
    stage(155, 'user.update_branch', 'human_review', 'implementing');
    stage(160, 'review.pass', 'ai_review', 'human_review');
    stage(161, 'auto.approve', 'human_review', 'done', 'auto_approved');

    const res = await call('GET', `/api/boards/${h.board.slug}/stats`);
    expect(res.status).toBe(200);
    expect(res.json.runs).toEqual([
      { kind: 'implement', runs: 3, failed: 1, totalMs: 40 * 60_000, medianMs: 20 * 60_000 },
      { kind: 'review', runs: 1, failed: 0, totalMs: 5 * 60_000, medianMs: 5 * 60_000 },
    ]);
    expect(res.json.answerWait).toEqual({ count: 1, totalMs: 4 * 60_000, medianMs: 4 * 60_000, open: 0 });
    // The auto-approved stay doesn't count as waiting for you.
    expect(res.json.reviewWait).toEqual({ count: 1, totalMs: 120 * 60_000, medianMs: 120 * 60_000, open: 0 });
    expect(res.json.mergeConflicts).toBe(1);
  });

  it('validates projects', async () => {
    h = await setup();
    const { call } = client();
    const ok = await call('POST', '/api/validate-project', { projectPath: h.repo });
    expect(ok.json).toMatchObject({ ok: true, isGitRepo: true, currentBranch: 'main', baseBranch: 'main', t3Known: true });
    const missing = await call('POST', '/api/validate-project', { projectPath: h.repo, baseBranch: 'nope' });
    expect(missing.json.ok).toBe(false);
    expect(missing.json.errors.join()).toMatch(/does not exist/);
    const notRepo = await call('POST', '/api/validate-project', { projectPath: h.tmp });
    expect(notRepo.json.isGitRepo).toBe(false);
  });

  it('settings patch is deep for notifications and board defaults', async () => {
    h = await setup();
    const { call } = client();
    const res = await call('PATCH', '/api/settings', { notifications: { sound: true }, boardDefaults: { maxParallel: 5 } });
    expect(res.json.notifications).toMatchObject({ sound: true, desktop: true });
    expect(res.json.boardDefaults).toMatchObject({ maxParallel: 5, aiReview: true });
  });
});
