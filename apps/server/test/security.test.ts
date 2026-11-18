import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { boards, runs, securityAudits, securityFindings, tasks } from '../src/db/schema.ts';
import { boardView } from '../src/db/views.ts';
import { reviewRunFor } from '../src/engine/runs.ts';
import { startAudit } from '../src/engine/security.ts';
import { createApp } from '../src/http/app.ts';
import { addFindingToBoard, boardSecurity, dismissFinding, markFindingFixed } from '../src/security/service.ts';
import { fence, setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

const finding = (title: string, o: Record<string, unknown> = {}) => ({
  title,
  severity: 'high',
  category: 'injection',
  file: 'src/api/search.ts',
  line: 42,
  description: `${title}: anyone can do it.`,
  details: '```ts\nquery(`... ${q}`)\n```',
  recommendation: 'Bind the parameter.',
  cwe: 'cwe-89',
  confidence: 'high',
  acceptanceCriteria: [`${title} is fixed`],
  touches: ['src/api/search.ts'],
  ...o,
});
const result = (findings: object[], o: Record<string, unknown> = {}) =>
  fence({
    summary: 'Small API, one serious hole.',
    attackSurface: '- `GET /api/search`',
    coverage: [{ area: 'Injection & input', status: 'issues', note: 'search' }],
    findings,
    ...o,
  });
const auditOf = (id: string) => h.db.select().from(securityAudits).where(eq(securityAudits.id, id)).get()!;
const all = () => h.db.select().from(securityFindings).all();

async function audit(body: Parameters<typeof startAudit>[2], reply: string) {
  const a = await startAudit(h.ctx, h.board.id, body);
  h.fake.finishRun(auditOf(a.id).threadId!, reply);
  await h.tick();
  return auditOf(a.id);
}

describe('security audits', () => {
  it('starts a read-only thread with the scope and focus, and records the findings, attack surface and coverage', async () => {
    h = await setup();
    let kicks = 0;
    h.ctx.kick = () => kicks++;
    h.db.update(boards).set({ securityBrief: 'Internal tool behind the VPN.' }).where(eq(boards.id, h.board.id)).run();
    const a = await startAudit(h.ctx, h.board.id, { scope: 'full', focus: ['injection', 'ai'], paths: [], instructions: 'Look hard at search.' });
    expect(kicks).toBe(1);
    const start = h.fake.calls.find((c) => c.op === 'start')!.args as { title: string; message: string; worktree?: unknown };
    expect(start.title).toMatch(/^Security audit #1: Full project \[tb \w+ sec-1\]$/);
    expect(start.worktree).toBeUndefined();
    expect(start.message).toContain('Read only. Do NOT edit');
    expect(start.message).toContain('**Injection & input**');
    expect(start.message).toContain('**AI & agents**');
    expect(start.message).not.toContain('**Cryptography**');
    expect(start.message).toContain('Internal tool behind the VPN.');
    expect(start.message).toContain('Look hard at search.');
    expect(start.message).toContain('No open findings from earlier audits.');
    expect(auditOf(a.id)).toMatchObject({ status: 'running', headSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    await expect(startAudit(h.ctx, h.board.id, { scope: 'full', focus: [], paths: [], instructions: '' })).rejects.toThrow(/still running/);

    h.fake.finishRun(auditOf(a.id).threadId!, result([finding('SQL injection in search'), finding('SQL injection in search'), finding('Weak cookie flags', { severity: 'low', category: 'nonsense', cwe: 'n/a', file: null, line: null, touches: [] })]));
    await h.tick();
    expect(auditOf(a.id)).toMatchObject({ status: 'done', summary: 'Small API, one serious hole.', attackSurface: '- `GET /api/search`', coverage: [{ area: 'Injection & input', status: 'issues', note: 'search' }] });
    expect(all().map((f) => [f.number, f.title, f.severity, f.category, f.cwe, f.status, f.source])).toEqual([
      [1, 'SQL injection in search', 'high', 'injection', 'CWE-89', 'open', 'audit'],
      [2, 'Weak cookie flags', 'low', 'other', null, 'open', 'audit'],
    ]);
    expect(h.db.select().from(runs).where(eq(runs.kind, 'security')).get()!.status).toBe('completed');
    const view = await boardSecurity(h.ctx, h.board.id);
    expect(view.audits[0]).toMatchObject({ number: 1, foundCount: 2, resolvedCount: 0, focus: ['injection', 'ai'] });
    expect(view.commitsSinceAudit).toBe(0);
    expect(boardView(h.db, h.db.select().from(boards).where(eq(boards.id, h.board.id)).get()!).securityOpen).toMatchObject({ high: 1, low: 1, critical: 0 });
  });

  it('gives the next audit the known findings, closes the ones it reports fixed, and reopens a fixed one that is back', async () => {
    h = await setup();
    await audit({ scope: 'full', focus: [], paths: [], instructions: '' }, result([finding('SQL injection in search'), finding('Open redirect after login', { file: 'src/auth.ts' })]));
    const [sqli, redirect] = all();
    dismissFinding(h.ctx, redirect!.id, { reason: 'accepted_risk', note: 'only to our own domains', undo: false });

    const a2 = await audit({ scope: 'full', focus: [], paths: [], instructions: '' }, result([finding('Open redirect after login', { file: 'src/auth.ts' })], { resolved: ['S-1', 'S-99'] }));
    const prompt = h.fake.calls.filter((c) => c.op === 'start').at(-1)!.args as { message: string };
    expect(prompt.message).toContain('- S-1 [high] src/api/search.ts:42: SQL injection in search');
    expect(prompt.message).toContain('S-2 [high] src/auth.ts:42: Open redirect after login (accepted risk: only to our own domains)');
    expect(all().find((f) => f.id === sqli!.id)).toMatchObject({ status: 'fixed', resolvedBy: 'audit', resolvedAuditId: a2.id });
    expect(all().find((f) => f.id === redirect!.id)).toMatchObject({ status: 'dismissed' });
    expect(all()).toHaveLength(2);
    expect((await boardSecurity(h.ctx, h.board.id)).audits[0]).toMatchObject({ number: 2, foundCount: 0, resolvedCount: 1 });

    await audit({ scope: 'full', focus: [], paths: [], instructions: '' }, result([finding('SQL injection in search', { severity: 'critical' })]));
    expect(all().find((f) => f.id === sqli!.id)).toMatchObject({ status: 'open', severity: 'critical', resolvedAt: null, resolvedBy: null });
  });

  it('audits the changes since the last audit, and refuses when there is nothing to compare with', async () => {
    h = await setup();
    await expect(startAudit(h.ctx, h.board.id, { scope: 'changes', focus: [], paths: [], instructions: '' })).rejects.toThrow(/no finished audit/);
    const first = await audit({ scope: 'full', focus: [], paths: [], instructions: '' }, result([]));
    await expect(startAudit(h.ctx, h.board.id, { scope: 'changes', focus: [], paths: [], instructions: '' })).rejects.toThrow(/Nothing was committed since audit #1/);
    const { execa } = await import('execa');
    await execa('git', ['-C', h.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'next']);
    const a = await startAudit(h.ctx, h.board.id, { scope: 'changes', focus: [], paths: [], instructions: '' });
    expect(auditOf(a.id)).toMatchObject({ baseSha: first.headSha, scope: 'changes' });
    const msg = (h.fake.calls.filter((c) => c.op === 'start').at(-1)!.args as { message: string }).message;
    expect(msg).toContain(`diff ${first.headSha}..${auditOf(a.id).headSha}`);
    expect((await boardSecurity(h.ctx, h.board.id)).commitsSinceAudit).toBe(1);
  });

  it('sends one correction for an unusable result, then fails the audit', async () => {
    h = await setup();
    const a = await startAudit(h.ctx, h.board.id, { scope: 'paths', focus: [], paths: ['src/api'], instructions: '' });
    expect((h.fake.calls.find((c) => c.op === 'start')!.args as { message: string }).message).toContain('- `src/api`');
    const threadId = auditOf(a.id).threadId!;
    h.fake.finishRun(threadId, 'I looked around, all good.');
    await h.tick();
    expect(auditOf(a.id)).toMatchObject({ status: 'running', correctionSent: true });
    expect(h.fake.calls.at(-1)).toMatchObject({ op: 'send' });
    h.fake.setStatus(threadId, 'running');
    await h.tick();
    h.fake.finishRun(threadId, fence({ summary: 'x', findings: 'none' }));
    await h.tick();
    expect(auditOf(a.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/still unusable after one correction: findings/) });
  });
});

describe('security findings', () => {
  it('goes to the board as a Backlog task, once; dismisses, marks fixed and undoes', async () => {
    h = await setup({ board: { acceptInto: 'ready' } });
    await audit({ scope: 'full', focus: [], paths: [], instructions: '' }, result([finding('SQL injection in search', { severity: 'critical' })]));
    const [f] = all();
    const { task } = addFindingToBoard(h.ctx, f!.id);
    expect(task).toMatchObject({ stage: 'backlog', title: 'Security: SQL injection in search', category: 'bug', priority: 'high', touches: ['src/api/search.ts'], acceptanceCriteria: ['SQL injection in search is fixed'] });
    expect(task.description).toContain('**Where:** `src/api/search.ts:42`');
    expect(task.description).toContain('### How to fix\n\nBind the parameter.');
    expect(task.description).toContain('S-1, security audit): critical severity');
    expect(all()[0]).toMatchObject({ status: 'added', taskId: task.id });
    expect(() => addFindingToBoard(h.ctx, f!.id)).toThrow(/already #1 on the board/);

    dismissFinding(h.ctx, f!.id, { reason: 'false_positive', note: 'not reachable', undo: false });
    expect(all()[0]).toMatchObject({ status: 'dismissed', dismissReason: 'false_positive', dismissNote: 'not reachable' });
    dismissFinding(h.ctx, f!.id, { reason: 'false_positive', note: '', undo: true });
    expect(all()[0]).toMatchObject({ status: 'added', dismissReason: null });
    markFindingFixed(h.ctx, f!.id, false);
    expect(all()[0]).toMatchObject({ status: 'fixed', resolvedBy: 'user' });
    expect(() => addFindingToBoard(h.ctx, f!.id)).toThrow(/Reopen it first/);
    // The task is done meanwhile: reopening leaves it open, and it can go to the board again.
    h.db.update(tasks).set({ stage: 'done' }).where(eq(tasks.id, task.id)).run();
    markFindingFixed(h.ctx, f!.id, true);
    expect(all()[0]).toMatchObject({ status: 'open', resolvedAt: null });
    expect(addFindingToBoard(h.ctx, f!.id).task.number).toBe(2);
  });

  it('adds the security checklist to AI reviews when the board asks for it', async () => {
    h = await setup();
    const t = h.newTask({ title: 'Add login' });
    const board = () => h.db.select().from(boards).where(eq(boards.id, h.board.id)).get()!;
    expect(reviewRunFor(h.ctx, board(), h.task(t.id)).promptText).not.toContain('## Security checks');
    h.db.update(boards).set({ securityReview: true, securityBrief: 'Holds payment data.' }).where(eq(boards.id, h.board.id)).run();
    const prompt = reviewRunFor(h.ctx, board(), h.task(t.id)).promptText;
    expect(prompt).toContain('## Security checks (this board asks for them)');
    expect(prompt).toContain('Start the title of each security finding with "Security:"');
    expect(prompt).toContain('Holds payment data.');
  });

  it('serves the security view, the report and the actions over HTTP', async () => {
    h = await setup();
    const app = createApp({ engine: h.engine, port: 4417 });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { host: '127.0.0.1:4417', 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'x-t3orchestra': '1' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, headers: res.headers, text: await res.text() };
    };
    const started = await call('POST', `/api/boards/${h.board.slug}/security/audits`, { scope: 'paths', paths: [] });
    expect(started.status).toBe(400);
    expect(started.text).toContain('name at least one path');
    const ok = await call('POST', `/api/boards/${h.board.slug}/security/audits`, { focus: ['web'] });
    expect(ok.status).toBe(201);
    const a = JSON.parse(ok.text);
    expect(a).toMatchObject({ number: 1, scope: 'full', focus: ['web'], status: 'running' });
    h.fake.finishRun(auditOf(a.id).threadId!, result([finding('Reflected XSS in the error page', { category: 'web' })]));
    await h.tick();

    const view = JSON.parse((await call('GET', `/api/boards/${h.board.slug}/security`)).text);
    expect(view.findings).toHaveLength(1);
    expect(view.findings[0]).toMatchObject({ number: 1, auditNumber: 1, status: 'open', meta: { kind: 'audit' } });
    const added = await call('POST', `/api/security/findings/${view.findings[0].id}/add`);
    expect(added.status).toBe(201);
    expect(JSON.parse(added.text)).toMatchObject({ finding: { status: 'added', taskNumber: 1, taskStage: 'backlog' }, task: { number: 1 } });

    const report = await call('GET', `/api/boards/${h.board.slug}/security/report`);
    expect(report.headers.get('content-type')).toContain('text/markdown');
    expect(report.headers.get('content-disposition')).toMatch(/attachment; filename=".+-security-\d{4}-\d{2}-\d{2}\.md"/);
    expect(report.text).toContain('# Security report: Test Board');
    expect(report.text).toContain('S-1 · High · Reflected XSS in the error page → task #1 (backlog)');
    expect(report.text).toContain('| Injection & input | issues | search |');

    const scan = await call('POST', `/api/boards/${h.board.slug}/security/scans`, { kind: 'secrets' });
    expect(scan.status).toBe(202);
    expect(JSON.parse(scan.text)).toMatchObject({ kind: 'secrets', status: 'running' });
  });
});
