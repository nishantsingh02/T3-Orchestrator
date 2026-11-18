import fs from 'node:fs';
import path from 'node:path';
import { DesignChoice, TaskActionBody, type DesignChoiceInput, type TaskDetailView } from '@t3-orchestra/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { designRounds } from '../src/db/schema.ts';
import { runAction } from '../src/engine/actions.ts';
import { AppError } from '../src/engine/context.ts';
import { designDir } from '../src/engine/designs.ts';
import { createApp } from '../src/http/app.ts';
import { fence, implDone, reviewPass, setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

const HOST = { host: '127.0.0.1:4417' };

const PAGE = (title: string) => `<!doctype html><title>${title}</title><p>${title}</p>`;
const optionsResult = (files: string[], extra: Record<string, unknown> = {}) =>
  fence({
    status: 'options',
    summary: 'Two layouts for the settings page.',
    question: 'Which layout should settings use?',
    options: files.map((file) => ({ file, title: `Title of ${file}`, summary: `About ${file}` })),
    ...extra,
  });

/** Writes HTML pages into the task's design folder for `round`. */
function savePages(taskId: string, round: number, names: string[]) {
  const dir = designDir(h.ctx.config.dataDir, taskId, round);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), PAGE(n));
  return dir;
}

const choose = (taskId: string, design: DesignChoiceInput) =>
  runAction(h.ctx, taskId, 'choose-design', TaskActionBody.parse({ design }));

async function waitingForPick(title = 'Redesign the settings page') {
  const t = h.newTask({ title });
  await runAction(h.ctx, t.id, 'start', {});
  savePages(t.id, 1, ['b-top-tabs.html', 'a-sidebar.html', 'z-extra.html', 'notes.txt']);
  await h.finish(t.id, optionsResult(['a-sidebar.html', 'b-top-tabs.html', 'missing.html']));
  return t;
}

const roundsOf = (taskId: string) => h.db.select().from(designRounds).where(eq(designRounds.taskId, taskId)).all();
const lastPrompt = (taskId: string) => h.runsOf(taskId).at(-1)!.promptText;
/** Every prompt names the folder the same way (the fake agent and the docs rely on it). */
const FOLDER_LINE = (dir: string, indent = '  ') => `design folder (outside the repo, never commit it):\n${indent}${dir}`;

describe('design options', () => {
  it('names the design folder in the implement prompt', async () => {
    h = await setup();
    const t = h.newTask({ title: 'Settings page' });
    await runAction(h.ctx, t.id, 'start', {});
    const prompt = lastPrompt(t.id);
    expect(prompt).toContain('## Design options');
    expect(prompt).toContain(FOLDER_LINE(designDir(h.ctx.config.dataDir, t.id, 1), '     '));
    expect(prompt).not.toContain('Design already chosen');
  });

  it('an options result parks the task in Human Review with the round recorded', async () => {
    h = await setup();
    const t = await waitingForPick();
    const task = h.task(t.id);
    expect(task.stage).toBe('human_review');
    expect(task.stageReason).toBe('design_options');
    // Nothing was built: the last result stays empty and the run never reached AI review.
    expect(task.lastResult).toBeNull();
    expect(h.runsOf(t.id).map((r) => r.kind)).toEqual(['implement']);

    const [round] = roundsOf(t.id);
    expect(round).toMatchObject({ round: 1, status: 'open', question: 'Which layout should settings use?' });
    // The agent's order and titles first, then pages it didn't list; missing files and non-pages dropped.
    expect(round!.options).toEqual([
      { file: 'a-sidebar.html', title: 'Title of a-sidebar.html', summary: 'About a-sidebar.html' },
      { file: 'b-top-tabs.html', title: 'Title of b-top-tabs.html', summary: 'About b-top-tabs.html' },
      { file: 'z-extra.html', title: 'Extra', summary: '' },
    ]);
    expect(h.view(t.id).design).toEqual({ round: 1, status: 'open', options: 3 });
    expect(h.notifications().some((n) => n.type === 'human_review' && n.title.includes('3 design options'))).toBe(true);
  });

  it('refuses to approve, open a PR or re-review while a pick is pending', async () => {
    h = await setup();
    const t = await waitingForPick();
    for (const action of ['approve', 'open-pr', 'rerun-review'] as const) {
      await expect(runAction(h.ctx, t.id, action, {}), action).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    }
    expect(h.task(t.id).stage).toBe('human_review');
  });

  it('build: sends the picks with their paths and notes, then reviews against them', async () => {
    h = await setup();
    const t = await waitingForPick();
    await choose(t.id, { mode: 'build', picks: [{ round: 1, file: 'b-top-tabs.html', note: 'the tabs' }, { round: 1, file: 'a-sidebar.html' }], notes: 'Keep it dark.' });

    let task = h.task(t.id);
    expect(task.stage).toBe('implementing');
    const run = h.openRun(t.id)!;
    expect(run.kind).toBe('design');
    expect(run.promptText).toContain('Build this now');
    expect(run.promptText).toContain('combine them');
    expect(run.promptText).toContain(path.join(designDir(h.ctx.config.dataDir, t.id, 1), 'b-top-tabs.html'));
    expect(run.promptText).toContain('option B "Title of b-top-tabs.html"');
    expect(run.promptText).toContain('What to take from it: the tabs');
    expect(run.promptText).toContain('Keep it dark.');
    expect(roundsOf(t.id)[0]).toMatchObject({ status: 'chosen', choice: { mode: 'build', notes: 'Keep it dark.' } });

    await h.finish(t.id, implDone('built the tabs'));
    task = h.task(t.id);
    expect(task.stage).toBe('ai_review');
    expect(h.openRun(t.id)!.promptText).toContain('## Design the user chose');
    await h.finish(t.id, reviewPass());
    expect(h.task(t.id).stage).toBe('human_review');
    expect(h.task(t.id).stageReason).toBe('ai_passed');
  });

  it('more: asks for the next round, which can be combined with older ones', async () => {
    h = await setup();
    const t = await waitingForPick();
    await choose(t.id, { mode: 'more', picks: [{ round: 1, file: 'a-sidebar.html', note: 'closest' }], notes: 'Try something lighter' });
    const run = h.openRun(t.id)!;
    expect(run.kind).toBe('options');
    expect(run.round).toBe(2);
    expect(run.promptText).toContain('Make round 2');
    expect(run.promptText).toContain(FOLDER_LINE(designDir(h.ctx.config.dataDir, t.id, 2)));
    expect(roundsOf(t.id)[0]!.status).toBe('more');

    savePages(t.id, 2, ['a-light.html', 'b-lighter.html']);
    await h.finish(t.id, optionsResult(['a-light.html', 'b-lighter.html']));
    expect(h.task(t.id).stageReason).toBe('design_options');
    expect(roundsOf(t.id).map((r) => [r.round, r.status])).toEqual([
      [1, 'more'],
      [2, 'open'],
    ]);

    await choose(t.id, { mode: 'build', picks: [{ round: 2, file: 'b-lighter.html' }, { round: 1, file: 'a-sidebar.html', note: 'its nav' }] });
    const prompt = h.openRun(t.id)!.promptText;
    expect(prompt).toContain('Round 2, option B');
    expect(prompt).toContain('Round 1, option A');
  });

  it('validates the choice', async () => {
    h = await setup();
    expect(DesignChoice.safeParse({ mode: 'build', picks: [], notes: ' ' }).success).toBe(false);
    const t = await waitingForPick();
    await expect(choose(t.id, { mode: 'build', picks: [{ round: 1, file: 'notes.txt' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(choose(t.id, { mode: 'build', picks: [{ round: 2, file: 'a-sidebar.html' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(runAction(h.ctx, t.id, 'choose-design', {})).rejects.toBeInstanceOf(AppError);
    expect(h.task(t.id).stage).toBe('human_review');

    // Once the task moves on (here: a message to the agent), there is nothing to pick from.
    await runAction(h.ctx, t.id, 'send-message', { text: 'Make the options darker' });
    expect(lastPrompt(t.id)).toContain(FOLDER_LINE(designDir(h.ctx.config.dataDir, t.id, 2)));
    await expect(choose(t.id, { mode: 'build', picks: [{ round: 1, file: 'a-sidebar.html' }] })).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('options without any saved page fail the run with the folder named', async () => {
    h = await setup();
    const t = h.newTask({ title: 'Redesign' });
    await runAction(h.ctx, t.id, 'start', {});
    await h.finish(t.id, optionsResult(['a.html']));
    const task = h.task(t.id);
    expect(task.stage).toBe('failed');
    expect(task.stageReason).toBe('agent_blocked');
    expect(task.lastMessage).toContain(designDir(h.ctx.config.dataDir, t.id, 1));
    expect(roundsOf(t.id)).toEqual([]);
  });

  it('a fresh retry after a chosen design builds it instead of asking again', async () => {
    h = await setup();
    const t = await waitingForPick();
    await choose(t.id, { mode: 'build', picks: [{ round: 1, file: 'a-sidebar.html' }] });
    await h.finish(t.id, fence({ status: 'blocked', summary: 'stuck', blockedReason: 'broken env' }));
    expect(h.task(t.id).stage).toBe('failed');
    await runAction(h.ctx, t.id, 'retry-fresh', {});
    const prompt = lastPrompt(t.id);
    expect(prompt).toContain('## Design already chosen');
    expect(prompt).toContain(path.join(designDir(h.ctx.config.dataDir, t.id, 1), 'a-sidebar.html'));
    expect(prompt).not.toContain('## Design options');
  });

  it('serves the pages sandboxed, and lists the rounds on the task', async () => {
    h = await setup();
    const app = createApp({ engine: h.engine, port: 4417 });
    const t = await waitingForPick();
    const dir = designDir(h.ctx.config.dataDir, t.id, 1);
    fs.writeFileSync(path.join(dir, 'shared.css'), 'body{}');
    fs.writeFileSync(path.join(h.ctx.config.dataDir, 'outside.html'), 'secret');

    const detail = (await (await app.request(`/api/tasks/${t.id}`, { headers: HOST })).json()) as TaskDetailView;
    expect(detail.design).toEqual({ round: 1, status: 'open', options: 3 });
    expect(detail.designRounds).toHaveLength(1);
    expect(detail.designRounds[0]).toMatchObject({ round: 1, awaiting: true, question: 'Which layout should settings use?' });
    expect(detail.designRounds[0]!.options.map((o) => `${o.letter} ${o.file}`)).toEqual([
      'A a-sidebar.html',
      'B b-top-tabs.html',
      'C z-extra.html',
    ]);

    const page = await app.request(detail.designRounds[0]!.options[0]!.url, { headers: HOST });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(await page.text()).toBe(PAGE('a-sidebar.html'));

    const css = await app.request(`/api/tasks/${t.id}/designs/1/shared.css`, { headers: HOST });
    expect(css.status).toBe(200);
    expect(css.headers.get('cache-control')).toBe('no-cache');

    for (const p of ['1/notes.txt', '1/missing.html', '0/a-sidebar.html', 'x/a-sidebar.html', '1/..%2F..%2F..%2Foutside.html', '1/..%5C..%5C..%5Coutside.html']) {
      const res = await app.request(`/api/tasks/${t.id}/designs/${p}`, { headers: HOST });
      expect(res.status, p).toBe(404);
    }
  });
});
