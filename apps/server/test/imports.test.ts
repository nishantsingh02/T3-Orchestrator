import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { boards, projectImports, runs } from '../src/db/schema.ts';
import { boardView } from '../src/db/views.ts';
import { gitRepo } from './harness.ts';
import { applyToBrief, beginImport, listT3Projects, pickThreads, startImport } from '../src/engine/imports.ts';
import { validateProject } from '../src/engine/boards.ts';
import { createApp } from '../src/http/app.ts';
import { normalizeProjects, type ThreadSummary } from '../src/t3/T3Client.ts';
import { fence, setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

const result = (o: Record<string, unknown> = {}) => ({
  summary: 'A todo app; sync is half done.',
  about: '**Stack:** React + Hono. Code in `src/`.',
  state: '- **Done:** lists\n- **In flight:** sync on branch `sync`',
  nextSteps: ['Finish sync', 'Add sharing'],
  ...o,
});
const importOf = (id: string) => h.db.select().from(projectImports).where(eq(projectImports.id, id)).get()!;
const board = () => h.db.select().from(boards).where(eq(boards.id, h.board.id)).get()!;
const lastStart = () => h.fake.calls.filter((c) => c.op === 'start').at(-1)!.args as { title: string; message: string; project: string; worktree?: unknown };

const summary = (title: string, o: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId: title,
  projectId: 'p',
  title,
  link: null,
  status: 'completed',
  latestRunId: null,
  providerInstanceId: null,
  model: null,
  runtimeMode: null,
  interactionMode: null,
  linkedPullRequest: null,
  pullRequests: [],
  itemCount: 3,
  settled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...o,
});

describe('imports from T3 history', () => {
  it('picks open threads first, then the newest, and leaves out sub-agents and T3 Orchestra reviews', () => {
    const day = (d: number) => `2026-01-${String(d).padStart(2, '0')}T00:00:00.000Z`;
    const threads = [
      ...Array.from({ length: 30 }, (_, i) => summary(`done ${i + 1}`, { updatedAt: day(i + 1) })),
      summary('old but open', { updatedAt: '2025-06-01T00:00:00.000Z', settled: false }),
      summary('a sub-agent', { updatedAt: day(31), parentThreadId: 'done 30' }),
      summary('Review #4 r1: Login [tb ab12-4 r1]', { updatedAt: day(31) }),
      summary('Import #1: what x is [tb ab12 import-1]', { updatedAt: day(31) }),
      summary('#4 Login [tb ab12-4]', { updatedAt: day(31) }),
    ];
    const picked = pickThreads(threads);
    expect(picked.total).toBe(32);
    expect(picked.detail).toHaveLength(25);
    expect(picked.detail[0]!.title).toBe('#4 Login [tb ab12-4]');
    expect(picked.detail.map((t) => t.title)).toContain('old but open');
    expect(picked.detail.at(-1)!.title).toBe('old but open');
    expect(picked.index.map((t) => t.title)).toEqual(['done 7', 'done 6', 'done 5', 'done 4', 'done 3', 'done 2', 'done 1']);
  });

  it('reads the threads, starts a read-only agent and writes its project context into the brief', async () => {
    h = await setup();
    h.fake.seedHistory(h.repo, [
      { title: 'Build the todo list', ask: 'Make a todo list with React.', reply: 'Done: `src/List.tsx`. Run with `pnpm dev`.', daysAgo: 9 },
      { title: 'Sync to the cloud', ask: 'Sync todos between devices.', reply: '## Status\nHalf done on branch `sync`.', daysAgo: 2, settled: false, branch: 'sync' },
      { title: 'Explore sync conflicts', ask: 'sub-agent work', reply: 'x', daysAgo: 2, parentThreadId: 'parent' },
      { title: 'Tweak the README', ask: 'Fix typos.', reply: 'Fixed.', daysAgo: 5, branch: 'main' },
    ]);
    let kicks = 0;
    h.ctx.kick = () => kicks++;
    const imp = await startImport(h.ctx, h.board.id);
    expect(kicks).toBe(1);
    expect(imp).toMatchObject({ status: 'running', threadCount: 3, threadsRead: 3, number: 1 });

    const start = lastStart();
    expect(start.title).toMatch(/^Import #1: what Test Board is and where it stands \[tb \w+ import-1\]$/);
    expect(start.project).toBe(h.board.projectPath);
    expect(start.worktree).toBeUndefined();
    expect(start.message).toContain('Do NOT edit, create, or delete files');
    expect(start.message).toContain("## The project's threads (3 in T3, newest first)");
    expect(start.message).toContain('### Sync to the cloud');
    expect(start.message).toContain('still open in T3 · branch `sync`');
    expect(start.message).toContain('**Asked:**\n> Make a todo list with React.');
    // A reply's own headings are quoted, so they can't break the digest.
    expect(start.message).toContain('**Last reply:**\n> ## Status\n> Half done on branch `sync`.');
    expect(start.message).not.toContain('Explore sync conflicts');
    // The root checkout's branch is not separate work.
    expect(start.message).toContain('### Tweak the README');
    expect(start.message).not.toContain('· branch `main`');
    expect(start.message).not.toContain('## The board brief now');
    expect(boardView(h.db, board()).projectImport).toMatchObject({ status: 'running', threadLink: expect.stringMatching(/fake/) });

    h.fake.finishRun(importOf(imp.id).threadId!, fence(result()));
    await h.tick();

    const done = importOf(imp.id);
    expect(done).toMatchObject({ status: 'done', summary: 'A todo app; sync is half done.', nextSteps: ['Finish sync', 'Add sharing'], error: null });
    const brief = board().brief;
    expect(brief).toBe(done.text);
    expect(brief).toMatch(/^## Project context \(from T3 Code history, \d{4}-\d\d-\d\d\)\n\n\*\*Stack:\*\* React \+ Hono/);
    expect(brief).toContain('### Where it stands\n- **Done:** lists');
    expect(brief).toContain('### Next steps\n1. Finish sync\n2. Add sharing');
    expect(h.db.select().from(runs).where(eq(runs.kind, 'import')).get()!.status).toBe('completed');
    expect(h.fake.calls.some((c) => c.op === 'settle')).toBe(true);
  });

  it('replaces the earlier context on a re-import and keeps the rest of the brief', async () => {
    h = await setup();
    h.fake.seedHistory(h.repo, [{ title: 'Build the todo list', ask: 'Make a todo list.', reply: 'Done.' }]);
    const first = await startImport(h.ctx, h.board.id);
    h.fake.finishRun(importOf(first.id).threadId!, fence(result({ about: 'Costs $5 a month ($& is not a pattern).' })));
    await h.tick();
    h.db.update(boards).set({ brief: `${board().brief}\n\n## Plan #1: Sharing\n\nShare lists by link.` }).where(eq(boards.id, h.board.id)).run();
    h.newTask({ title: 'Share lists by link' });

    const second = await startImport(h.ctx, h.board.id);
    const message = lastStart().message;
    expect(message).toContain('## The board brief now');
    expect(message).toContain('yours replaces it');
    expect(message).toContain('## Open tasks on this board');
    expect(message).toContain('#1 Share lists by link');
    h.fake.finishRun(importOf(second.id).threadId!, fence(result({ about: 'Now with sharing.' })));
    await h.tick();

    const brief = board().brief;
    expect(brief).toContain('Now with sharing.');
    expect(brief).not.toContain('Costs $5');
    expect(brief).toContain('## Plan #1: Sharing');
    expect(brief.match(/## Project context/g)).toHaveLength(1);
    expect(boardView(h.db, board()).projectImport).toMatchObject({ number: 2, status: 'done' });
  });

  it('puts the context first when the user rewrote the earlier one, and keeps `$` patterns literal', () => {
    expect(applyToBrief('', null, 'NEW')).toBe('NEW');
    expect(applyToBrief('notes\n\nOLD context', 'OLD context', 'NEW $& $1')).toBe('notes\n\nNEW $& $1');
    expect(applyToBrief('edited by hand', 'OLD context', 'NEW')).toBe('NEW\n\nedited by hand');
  });

  it('sends one correction for an unusable result, then fails', async () => {
    h = await setup();
    const imp = await startImport(h.ctx, h.board.id);
    expect(lastStart().message).toContain('T3 has no threads for this project yet');
    const threadId = importOf(imp.id).threadId!;
    h.fake.finishRun(threadId, fence({ summary: 'x' }));
    await h.tick();
    expect(importOf(imp.id)).toMatchObject({ status: 'running', correctionSent: true });
    expect((h.fake.calls.at(-1)!.args as { message: string }).message).toMatch(/^Your project context could not be used: about:/);

    h.fake.finishRun(threadId, 'No block this time.');
    await h.tick();
    expect(importOf(imp.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/still unusable after one correction/) });
    expect(board().brief).toBe('');
  });

  it('runs one import per board at a time and fails when T3 cannot list the threads', async () => {
    h = await setup();
    await startImport(h.ctx, h.board.id);
    expect(() => beginImport(h.ctx, h.board.id)).toThrow(/already learning/);

    const other = await gitRepo(path.join(h.tmp, 'other'));
    const row = h.db.select().from(boards).where(eq(boards.id, h.board.id)).get()!;
    h.db.insert(boards).values({ ...row, id: 'b2', slug: 'other', short: 'ffff', projectPath: other, t3ProjectId: null }).run();
    const list = h.fake.list.bind(h.fake);
    h.fake.list = async () => {
      throw new Error('boom');
    };
    const failed = await startImport(h.ctx, 'b2');
    h.fake.list = list;
    expect(failed).toMatchObject({ status: 'failed', error: "Could not read the project's threads from T3: boom" });
  });

  it('lists T3 projects with the board that points at each, and counts threads when validating', async () => {
    h = await setup();
    h.fake.seedHistory(h.repo, [{ title: 'One', ask: 'a', reply: 'b' }, { title: 'Two', ask: 'a', reply: 'b' }]);
    const other = await gitRepo(path.join(h.tmp, 'other'));
    h.fake.seedHistory(other, [{ title: 'Three', ask: 'a', reply: 'b', daysAgo: 30 }]);
    const projects = await listT3Projects(h.ctx);
    expect(projects.map((p) => [path.basename(p.path), p.threadCount, p.boardSlug])).toEqual([
      ['repo', 2, h.board.slug],
      ['other', 1, null],
    ]);
    expect((await validateProject(h.ctx, other)).t3ThreadCount).toBe(1);
  });

  it('starts the import when a board is created with importFromT3', async () => {
    h = await setup();
    const other = await gitRepo(path.join(h.tmp, 'other'));
    h.fake.seedHistory(other, [{ title: 'One', ask: 'a', reply: 'b' }]);
    const app = createApp({ engine: h.engine, port: 4417 });
    const res = await app.request('/api/boards', {
      method: 'POST',
      headers: { host: '127.0.0.1:4417', 'content-type': 'application/json', 'x-t3orchestra': '1' },
      body: JSON.stringify({ name: 'Other', projectPath: other, importFromT3: true }),
    });
    expect(res.status).toBe(201);
    const view = (await res.json()) as { id: string; projectImport: { status: string } | null };
    expect(view.projectImport).toMatchObject({ status: 'gathering' });
    // The threads are collected after the response.
    const imp = () => h.db.select().from(projectImports).where(eq(projectImports.boardId, view.id)).get()!;
    for (let i = 0; i < 100 && imp().status === 'gathering'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(imp()).toMatchObject({ status: 'running', threadCount: 1 });
  });

  it('reads projects and thread counts out of T3 shell snapshots', () => {
    const projects = normalizeProjects({
      projects: [
        { id: 'a', title: 'Alpha', workspaceRoot: 'C:\\code\\alpha', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', title: 'Beta', workspaceRoot: 'C:\\code\\beta', updatedAt: '2026-02-01T00:00:00.000Z' },
        { id: 'c', title: 'Gone', workspaceRoot: 'C:\\code\\gone', archivedAt: '2026-01-01T00:00:00.000Z' },
      ],
      threads: [
        { id: 't1', projectId: 'a', latestUserMessageAt: '2026-03-01T00:00:00.000Z', lineage: { parentThreadId: null } },
        { id: 't2', projectId: 'a', updatedAt: '2026-01-05T00:00:00.000Z' },
        { id: 't3', projectId: 'a', lineage: { parentThreadId: 't1' }, updatedAt: '2026-04-01T00:00:00.000Z' },
        { id: 't4', projectId: 'b', deletedAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    expect(projects).toEqual([
      { id: 'a', title: 'Alpha', path: 'C:\\code\\alpha', threadCount: 2, lastActivityAt: '2026-03-01T00:00:00.000Z' },
      { id: 'b', title: 'Beta', path: 'C:\\code\\beta', threadCount: 0, lastActivityAt: '2026-02-01T00:00:00.000Z' },
    ]);
  });
});
