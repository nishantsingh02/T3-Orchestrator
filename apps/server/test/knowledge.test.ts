import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeResult, MAX_KNOWLEDGE_FILE_BYTES, type KnowledgeGraph, type KnowledgeNode } from '@t3-orchestra/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { boards, contextBuilds, contextFiles, runs } from '../src/db/schema.ts';
import { continueBuilds, pickBatch, startBuild } from '../src/engine/knowledge.ts';
import { implementPrompt } from '../src/engine/runs.ts';
import { createApp } from '../src/http/app.ts';
import { contextFolder, graphFilePath, isContextPath, legacyContextDir, safeFileName } from '../src/knowledge/files.ts';
import { applyResult, buildStats, dropFiles } from '../src/knowledge/graph.ts';
import { addFile, boardKnowledge, describeFile, knowledgeFor, loadGraph, removeFile, searchKnowledge, syncFromProject } from '../src/knowledge/service.ts';
import { knowledgeText, rankNodes, searchText } from '../src/knowledge/text.ts';
import { fence, setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

const node = (key: string, o: Partial<KnowledgeNode> = {}): KnowledgeNode => ({
  key,
  name: key.replace(/-/g, ' '),
  type: 'feature',
  summary: `About ${key}.`,
  aliases: [],
  sources: [{ fileId: 'f1', where: '', quote: '' }],
  code: [],
  updatedAt: '2026-11-09T00:00:00.000Z',
  ...o,
});
const input = (key: string, file: string, o: Record<string, unknown> = {}) =>
  KnowledgeResult.shape.nodes.parse([{ key, name: key, type: 'feature', summary: `From ${file}.`, sources: [{ file }], ...o }])[0]!;

const text = (s: string) => new TextEncoder().encode(s);
const settle = () => new Promise((r) => setTimeout(r, 30));
const buildRow = (id: string) => h.db.select().from(contextBuilds).where(eq(contextBuilds.id, id)).get()!;
const fileRow = (id: string) => h.db.select().from(contextFiles).where(eq(contextFiles.id, id)).get()!;
const startMessages = () => h.fake.calls.filter((c) => c.op === 'start').map((c) => (c.args as { message: string; title: string }));

const SPEC = '# Billing\nPayments go through Stripe Checkout.\n\n## Refund window\nOnly admins refund, within 30 days.\n';
const specResult = (o: Record<string, unknown> = {}) =>
  fence({
    summary: 'Billing rules.',
    digest: '**Billing:** Stripe Checkout; refunds within 30 days by admins.',
    files: [{ file: 'billing.md', summary: 'How payments and refunds work.' }],
    nodes: [
      { key: 'Stripe Checkout', name: 'Stripe Checkout', type: 'integration', summary: 'Payments go through Stripe Checkout.', sources: [{ file: 'billing.md', where: 'Billing' }], code: ['./src/billing/stripe.ts'] },
      { key: 'refund-window', name: 'Refund window', type: 'rule', summary: 'Only admins refund, within 30 days.', aliases: ['refund policy'], sources: [{ file: 'C:\\somewhere\\BILLING.md', where: 'Refund window', quote: 'within 30 days' }] },
      { key: 'ghost', name: 'Ghost', type: 'term', summary: 'Cites a file nobody uploaded.', sources: [{ file: 'nope.md' }] },
    ],
    edges: [
      { from: 'refund-window', to: 'stripe-checkout', relation: 'Constrains' },
      { from: 'refund-window', to: 'ghost', relation: 'relates to' },
    ],
    ...o,
  });

describe('knowledge graph data', () => {
  it('drops what removed files said, and nodes left without a source with their edges', () => {
    const g = {
      nodes: [node('a'), node('b', { sources: [{ fileId: 'f1', where: '', quote: '' }, { fileId: 'f2', where: '', quote: '' }] }), node('c', { sources: [{ fileId: 'f2', where: '', quote: '' }] })],
      edges: [
        { from: 'a', to: 'b', relation: 'uses', fileId: 'f2' },
        { from: 'b', to: 'c', relation: 'uses', fileId: 'f1' },
        { from: 'c', to: 'b', relation: 'uses', fileId: null },
      ],
    };
    const out = dropFiles(g, new Set(['f1']));
    expect(out.nodes.map((n) => [n.key, n.sources.map((s) => s.fileId)])).toEqual([
      ['b', ['f2']],
      ['c', ['f2']],
    ]);
    expect(out.edges).toEqual([{ from: 'c', to: 'b', relation: 'uses', fileId: null }]);
  });

  it('adds a result: known files only, existing nodes updated in place, edges need both ends', () => {
    const files = [
      { id: 'f1', name: 'old.md' },
      { id: 'f2', name: 'new.md' },
    ];
    const base = { nodes: [node('a'), node('b')], edges: [] };
    const { graph, touched } = applyResult(
      base,
      {
        nodes: [input('a', 'new.md', { summary: 'Updated.', aliases: ['A one', 'a'] }), input('c', 'new.md'), input('d', 'missing.md')],
        edges: [
          { from: 'c', to: 'a', relation: 'depends on' },
          { from: 'c', to: 'd', relation: 'uses' },
          { from: 'c', to: 'c', relation: 'uses' },
        ],
      },
      { files, buildFiles: [files[1]!], now: 'now' },
    );
    expect(graph.nodes.map((n) => n.key)).toEqual(['a', 'b', 'c']);
    expect(graph.nodes[0]).toMatchObject({ summary: 'Updated.', aliases: ['A one'], sources: [{ fileId: 'f1' }, { fileId: 'f2' }], updatedAt: 'now' });
    // One file read: an edge that names none is put on it.
    expect(graph.edges).toEqual([{ from: 'c', to: 'a', relation: 'depends on', fileId: 'f2' }]);
    expect(buildStats(base, graph, touched)).toEqual({ added: 1, updated: 1, removed: 0, edges: 1 });
  });

  it('takes a lenient result: odd types mapped, keys slugged, long text clipped', () => {
    const r = KnowledgeResult.parse({
      summary: 's',
      digest: 'd',
      nodes: [{ key: 'Refund Window!', name: 'x', type: 'Persona', summary: 'y'.repeat(900), sources: [{ file: 'a.md' }] }],
      edges: [{ from: 'Refund Window', to: 'b', relation: 'uses' }],
    });
    expect(r.nodes[0]).toMatchObject({ key: 'refund-window', type: 'actor', aliases: [], code: [] });
    expect(r.nodes[0]!.summary).toHaveLength(700);
    expect(r.edges[0]!.from).toBe('refund-window');
    expect(KnowledgeResult.safeParse({ summary: 's', digest: '', nodes: [] }).success).toBe(false);
  });

  it('makes safe file names', () => {
    expect(safeFileName('C:\\Users\\me\\Spec v2.pdf')).toBe('Spec v2.pdf');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a<b>:c?.md')).toBe('a_b__c_.md');
    expect(safeFileName('.env')).toBe('env');
    expect(safeFileName('CON.txt')).toBe('_CON.txt');
    expect(safeFileName('...')).toBeNull();
    expect(safeFileName(`${'x'.repeat(200)}.md`)).toHaveLength(120);
  });

  it('tells context paths in git status apart', () => {
    expect(isContextPath('.t3orchestra/context/graph.json')).toBe(true);
    expect(isContextPath('".t3orchestra/context/files/Spec \\303\\251.pdf"')).toBe(true);
    expect(isContextPath('.t3orchestra/context')).toBe(true);
    expect(isContextPath('.t3orchestra/contextual.md')).toBe(false);
    expect(isContextPath('src/.t3orchestra/context/x')).toBe(false);
    expect(isContextPath('.t3board/context/graph.json')).toBe(true);
  });

  it('keeps using the folder from before the rename while the project has only that one', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 't3orchestra-folder-'));
    try {
      expect(contextFolder(repo)).toBe('.t3orchestra/context');
      fs.mkdirSync(path.join(repo, '.t3board', 'context'), { recursive: true });
      expect(contextFolder(repo)).toBe('.t3board/context');
      expect(graphFilePath(repo)).toBe(path.join(repo, '.t3board', 'context', 'graph.json'));
      fs.mkdirSync(path.join(repo, '.t3orchestra', 'context'), { recursive: true });
      expect(contextFolder(repo)).toBe('.t3orchestra/context');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('what agents read', () => {
  const g: KnowledgeGraph = {
    digest: '**Goal:** a billing app.',
    updatedAt: 'now',
    nodes: [
      node('refund-window', { name: 'Refund window', type: 'constraint', summary: 'Only admins refund, within 30 days.', aliases: ['refund policy'] }),
      node('stripe-checkout', { name: 'Stripe Checkout', type: 'integration', code: ['src/billing/stripe.ts'] }),
      node('user', { name: 'User', type: 'actor', summary: 'Anyone with an account.' }),
      node('glossary-term', { name: 'Seat', type: 'term' }),
    ],
    edges: [{ from: 'refund-window', to: 'stripe-checkout', relation: 'constrains', fileId: 'f1' }],
  };
  const files = [{ id: 'f1', name: 'billing.md', path: '/data/context/b/billing.md', status: 'indexed' as const, summary: 'Payments and refunds.', description: null }];

  it('ranks by shared words, names and code paths', () => {
    expect(rankNodes(g.nodes, { text: 'Let admins issue a refund from the order page' }).map((s) => s.node.key)).toEqual(['refund-window']);
    expect(rankNodes(g.nodes, { text: 'Fix the webhook', paths: ['src/billing'] }).map((s) => s.node.key)).toEqual(['stripe-checkout']);
    expect(rankNodes(g.nodes, { text: 'the and for' })).toEqual([]);
    // Summaries that mention refunds don't make the name word common.
    const support = node('support-team', { name: 'Support team', type: 'actor', summary: 'The admins. They handle refunds and account deletion.' });
    expect(rankNodes([...g.nodes, support], { text: 'Let support refund an order' }).map((s) => s.node.key).sort()).toEqual(['refund-window', 'support-team']);
  });

  it('gives the overview, the matching nodes with their links, and the files', () => {
    const t = knowledgeText(g, files, { text: 'Add a refund button for admins' }, { kind: 'task', mcpBoard: 'billing' });
    expect(t).toContain('## Project knowledge');
    expect(t).toContain('**Goal:** a billing app.');
    expect(t).toContain('### Relevant to this task');
    expect(t).toContain('- **Refund window** (Constraint): Only admins refund, within 30 days. _(billing.md)_');
    expect(t).toContain('Links: constrains **Stripe Checkout**.');
    expect(t).toContain('`/data/context/b/billing.md`: Payments and refunds.');
    expect(t).toContain('`context_search` (board "billing")');
    // Little matched: the best-connected nodes fill in, terms last.
    expect(t).toContain('### Also central');
    expect(t).not.toContain('**Seat**');
  });

  it('is empty for a board without context, and lists pending files before any graph exists', () => {
    expect(knowledgeText({ nodes: [], edges: [], digest: '', updatedAt: null }, [], { text: 'x' }, { kind: 'task' })).toBe('');
    const t = knowledgeText({ nodes: [], edges: [], digest: '', updatedAt: null }, [{ ...files[0]!, status: 'pending', summary: null }], { text: 'x' }, { kind: 'plan' });
    expect(t).toContain('billing.md` (not read into the graph yet)');
    expect(t).not.toContain('### Relevant');
  });

  it("puts the user's description of a file under it, on one line", () => {
    const described = [{ ...files[0]!, description: 'The signed-off billing spec.\n\nSection 4 is out of date.' }];
    const t = knowledgeText(g, described, { text: 'refund' }, { kind: 'task' });
    expect(t).toContain('`/data/context/b/billing.md`: Payments and refunds.\n  The user says: The signed-off billing spec. Section 4 is out of date.');
    expect(searchText({ ...g, nodes: [] }, described, '')).toContain('\n  The user says: The signed-off billing spec.');
  });

  it('stays under its size cap by dropping the least relevant nodes', () => {
    const many = Array.from({ length: 40 }, (_, i) => node(`refund-${i}`, { name: `Refund rule ${i}`, summary: `Refund detail ${'z'.repeat(450)}` }));
    const t = knowledgeText({ ...g, nodes: many, edges: [] }, files, { text: 'refund rule' }, { kind: 'task' });
    expect(t.length).toBeLessThanOrEqual(9000);
    expect(t).toContain('**Refund rule');
  });
});

describe('context files and builds', () => {
  it('stores uploads, replaces by name in any case, and skips identical re-uploads', async () => {
    h = await setup();
    const a = addFile(h.ctx, h.board.id, 'Billing.md', text(SPEC));
    expect(a).toMatchObject({ name: 'Billing.md', status: 'pending', kind: 'text', size: SPEC.length, reading: false });
    expect(fs.readFileSync(a.path, 'utf8')).toBe(SPEC);
    expect(addFile(h.ctx, h.board.id, 'Billing.md', text(SPEC)).updatedAt).toBe(a.updatedAt);
    h.db.update(contextFiles).set({ status: 'indexed' }).where(eq(contextFiles.id, a.id)).run();
    const b = addFile(h.ctx, h.board.id, 'billing.md', text(`${SPEC}\nMore.`));
    expect(b).toMatchObject({ id: a.id, name: 'billing.md', status: 'pending' });
    expect(fs.readdirSync(path.dirname(b.path))).toEqual(['billing.md']);
    expect(() => addFile(h.ctx, h.board.id, 'empty.txt', new Uint8Array())).toThrow(/empty/);
  });

  it('builds the graph with a read-only agent, then adds to it and takes removed files out', async () => {
    h = await setup();
    let kicks = 0;
    h.ctx.kick = () => kicks++;
    h.db.update(boards).set({ brief: 'A shop.' }).where(eq(boards.id, h.board.id)).run();
    const f = addFile(h.ctx, h.board.id, 'billing.md', text(SPEC));
    const b1 = await startBuild(h.ctx, h.board.id);
    expect(kicks).toBe(1);
    const start = startMessages()[0]!;
    expect(start.title).toMatch(/^Context #1: reading billing\.md into the knowledge graph \[tb \w+ ctx-1\]$/);
    expect(start.message).toContain('Read only. Do NOT edit');
    expect(start.message).toContain(`- \`${f.path}\` (`);
    expect(start.message).toContain('Empty: you start it.');
    expect(start.message).toContain('A shop.');
    expect(boardKnowledge(h.ctx, h.board.id).files[0]!.reading).toBe(true);
    await expect(startBuild(h.ctx, h.board.id)).rejects.toThrow(/still reading/);

    h.fake.finishRun(buildRow(b1.id).threadId!, specResult());
    await h.tick();
    expect(buildRow(b1.id)).toMatchObject({ status: 'done', summary: 'Billing rules.', stats: { added: 2, updated: 0, removed: 0, edges: 1 } });
    expect(h.db.select().from(runs).where(eq(runs.kind, 'knowledge')).get()!.status).toBe('completed');
    expect(fileRow(f.id)).toMatchObject({ status: 'indexed', summary: 'How payments and refunds work.' });
    const g1 = loadGraph(h.db, h.board.id);
    expect(g1.digest).toContain('Stripe Checkout');
    expect(g1.nodes.map((n) => [n.key, n.type, n.code])).toEqual([
      ['stripe-checkout', 'integration', ['src/billing/stripe.ts']],
      ['refund-window', 'constraint', []],
    ]);
    expect(g1.edges).toEqual([{ from: 'refund-window', to: 'stripe-checkout', relation: 'constrains', fileId: f.id }]);
    await expect(startBuild(h.ctx, h.board.id)).rejects.toThrow(/already in the graph/);

    // A second file: the prompt lists the graph so far, and the result adds to it.
    const notes = addFile(h.ctx, h.board.id, 'notes.txt', text('Admins are the support team.'));
    const b2 = await startBuild(h.ctx, h.board.id);
    const second = startMessages()[1]!.message;
    expect(second).toContain('2 nodes from 1 other file(s)');
    expect(second).toContain('- `refund-window` (constraint) Refund window: Only admins refund, within 30 days.');
    expect(second).toContain('- billing.md: How payments and refunds work.');
    expect(second).toContain('**Billing:** Stripe Checkout');
    h.fake.finishRun(
      buildRow(b2.id).threadId!,
      fence({
        summary: 'Who admins are.',
        digest: 'Billing plus support.',
        nodes: [
          { key: 'support-team', name: 'Support team', type: 'actor', summary: 'The admins.', sources: [{ file: 'notes.txt' }] },
          { key: 'refund-window', name: 'Refund window', type: 'constraint', summary: 'Support refunds within 30 days.', sources: [{ file: 'notes.txt' }] },
        ],
        edges: [{ from: 'refund-window', to: 'support-team', relation: 'owned by' }],
      }),
    );
    await h.tick();
    expect(buildRow(b2.id).stats).toEqual({ added: 1, updated: 1, removed: 0, edges: 2 });
    expect(loadGraph(h.db, h.board.id).nodes.find((n) => n.key === 'refund-window')!.sources.map((s) => s.fileId)).toEqual([f.id, notes.id]);

    // The prompt of a task about refunds now carries the knowledge.
    const task = h.newTask({ title: 'Let support refund an order', description: 'Add a refund button.' });
    const board = h.db.select().from(boards).where(eq(boards.id, h.board.id)).get()!;
    const prompt = implementPrompt(h.ctx, board, task, 'tb/x');
    expect(prompt).toContain('## Project knowledge');
    expect(prompt).toContain('- **Refund window** (Constraint): Support refunds within 30 days.');
    expect(prompt).toContain('Billing plus support.');
    h.db.update(boards).set({ contextInPrompts: false }).where(eq(boards.id, h.board.id)).run();
    expect(implementPrompt(h.ctx, { ...board, contextInPrompts: false }, task, 'tb/x')).not.toContain('## Project knowledge');
    expect(searchKnowledge(h.ctx, h.board.id, 'refund')).toContain('### Refund window');
    expect(searchKnowledge(h.ctx, h.board.id, '')).toContain('**Actor** (1): Support team');

    // Removing a file takes out what only it said.
    removeFile(h.ctx, notes.id);
    const g3 = loadGraph(h.db, h.board.id);
    expect(g3.nodes.map((n) => n.key).sort()).toEqual(['refund-window', 'stripe-checkout']);
    expect(g3.edges.map((e) => e.relation)).toEqual(['constrains']);
    expect(fs.existsSync(notes.path)).toBe(false);
  });

  it('re-reads a changed file in place of what it said before', async () => {
    h = await setup();
    const f = addFile(h.ctx, h.board.id, 'billing.md', text(SPEC));
    const b1 = await startBuild(h.ctx, h.board.id);
    h.fake.finishRun(buildRow(b1.id).threadId!, specResult());
    await h.tick();
    addFile(h.ctx, h.board.id, 'billing.md', text('# Billing\nPaddle now.'));
    expect(fileRow(f.id).status).toBe('pending');
    const b2 = await startBuild(h.ctx, h.board.id);
    const msg = startMessages()[1]!.message;
    expect(msg).toContain('read before: it or its description changed');
    expect(msg).toContain('Empty: you start it.'); // everything it said was taken out
    h.fake.finishRun(
      buildRow(b2.id).threadId!,
      fence({ summary: 's', digest: 'Paddle.', nodes: [{ key: 'paddle', name: 'Paddle', type: 'integration', summary: 'Payments via Paddle.', sources: [{ file: 'billing.md' }] }] }),
    );
    await h.tick();
    expect(loadGraph(h.db, h.board.id).nodes.map((n) => n.key)).toEqual(['paddle']);
    expect(buildRow(b2.id).stats).toMatchObject({ added: 1, removed: 2 });
  });

  it("gives the build agent the user's description of a file, and reads the file again when it changes", async () => {
    h = await setup();
    const DESC = 'The signed-off billing spec.\nThe refund section is what matters.';
    const f = addFile(h.ctx, h.board.id, 'billing.md', text(SPEC), `  ${DESC}\r\n`);
    expect(f).toMatchObject({ description: DESC, status: 'pending' });
    const b1 = await startBuild(h.ctx, h.board.id);
    const first = startMessages()[0]!.message;
    expect(first).toContain(`- \`${f.path}\` (`);
    expect(first).toContain('  The user says: The signed-off billing spec.\n  The refund section is what matters.');
    expect(first).toContain('Where the user described a file ("The user says")');
    h.fake.finishRun(buildRow(b1.id).threadId!, specResult());
    await h.tick();
    expect(fileRow(f.id).status).toBe('indexed');
    const board = h.db.select().from(boards).where(eq(boards.id, h.board.id)).get()!;
    expect(knowledgeFor(h.ctx, board, { text: 'x' }, 'task')).toContain('The user says: The signed-off billing spec. The refund section is what matters.');

    // The same upload again, with no description given, keeps it and has nothing to read.
    expect(addFile(h.ctx, h.board.id, 'billing.md', text(SPEC))).toMatchObject({ description: DESC, status: 'indexed' });
    // Edited without reading it again: the graph stays; the same text, or a skipped re-read of a read file, changes nothing.
    expect(describeFile(h.ctx, f.id, { description: 'Billing spec, v2.', reread: false })).toMatchObject({ description: 'Billing spec, v2.', status: 'indexed' });
    expect(describeFile(h.ctx, f.id, { description: 'Billing spec, v2.', reread: true }).status).toBe('indexed');
    // Edited to be read again: pending, and the next build is told it was read before.
    expect(describeFile(h.ctx, f.id, { description: 'Billing spec, v3.', reread: true }).status).toBe('pending');
    const b2 = await startBuild(h.ctx, h.board.id);
    expect(startMessages()[1]!.message).toContain('read before: it or its description changed');
    expect(startMessages()[1]!.message).toContain('  The user says: Billing spec, v3.');

    // Described anew while the agent reads it: still pending afterwards, and the next build reads it.
    describeFile(h.ctx, f.id, { description: 'Billing spec, v4.', reread: false });
    h.fake.finishRun(buildRow(b2.id).threadId!, specResult());
    await h.tick();
    await settle();
    expect(buildRow(b2.id).status).toBe('done');
    expect(fileRow(f.id)).toMatchObject({ status: 'pending', description: 'Billing spec, v4.' });
    const b3 = boardKnowledge(h.ctx, h.board.id).builds[0]!;
    expect(b3.number).toBe(3);
    expect(startMessages().at(-1)!.message).toContain('  The user says: Billing spec, v4.');
    h.fake.finishRun(buildRow(b3.id).threadId!, specResult());
    await h.tick();
    expect(fileRow(f.id).status).toBe('indexed');

    // A new description with the upload has it read again; an empty one clears it.
    expect(addFile(h.ctx, h.board.id, 'billing.md', text(SPEC), '  ')).toMatchObject({ description: null, status: 'pending' });
    expect(() => describeFile(h.ctx, f.id, { description: 'x'.repeat(1001), reread: false })).toThrow(/at most 1000 characters/);

    // Other files' descriptions come along in a later build's list of the graph so far.
    const notes = addFile(h.ctx, h.board.id, 'notes.txt', text('Admins are the support team.'));
    h.db.update(contextFiles).set({ status: 'indexed', summary: 'How payments work.', description: 'Old, but the refund rules hold.' }).where(eq(contextFiles.id, f.id)).run();
    await startBuild(h.ctx, h.board.id);
    expect(buildRow(boardKnowledge(h.ctx, h.board.id).builds[0]!.id).files).toEqual([{ id: notes.id, name: 'notes.txt', sha256: expect.any(String), description: null }]);
    expect(startMessages().at(-1)!.message).toContain('- billing.md: How payments work.\n  The user says: Old, but the refund rules hold.');
    expect(startMessages().at(-1)!.message).not.toContain('Where the user described a file');
  });

  it('sends one correction for an unusable result, and fails the second time with the files left pending', async () => {
    h = await setup();
    const f = addFile(h.ctx, h.board.id, 'billing.md', text(SPEC));
    const b = await startBuild(h.ctx, h.board.id);
    const thread = buildRow(b.id).threadId!;
    h.fake.finishRun(thread, 'I read it but forgot the block.');
    await h.tick();
    expect(buildRow(b.id)).toMatchObject({ status: 'running', correctionSent: true });
    const sent = h.fake.calls.filter((c) => c.op === 'send').at(-1)!.args as { message: string };
    expect(sent.message).toMatch(/^Your knowledge graph result could not be used: no ```t3orchestra-result``` block found/);
    h.fake.finishRun(thread, fence({ summary: 's' }));
    await h.tick();
    expect(buildRow(b.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/still unusable after one correction: digest/) });
    expect(fileRow(f.id).status).toBe('pending');
  });

  it('reads many files in batches, one build after the other, and a fresh build replaces the graph', async () => {
    h = await setup();
    const many = Array.from({ length: 14 }, (_, i) => addFile(h.ctx, h.board.id, `note-${String(i).padStart(2, '0')}.md`, text(`# Note ${i}\nText ${i}.`)));
    expect(pickBatch(h.db.select().from(contextFiles).all())).toHaveLength(12);
    const b1 = await startBuild(h.ctx, h.board.id);
    expect(buildRow(b1.id).files).toHaveLength(12);
    h.fake.finishRun(
      buildRow(b1.id).threadId!,
      fence({ summary: 's', digest: 'd', nodes: [{ key: 'note-0', name: 'Note 0', type: 'term', summary: 'n', sources: [{ file: 'note-00.md' }] }] }),
    );
    await h.tick();
    await settle();
    const builds = boardKnowledge(h.ctx, h.board.id).builds;
    expect(builds.map((b) => [b.number, b.status, b.fileNames.length])).toEqual([
      [2, 'running', 2],
      [1, 'done', 12],
    ]);
    h.fake.finishRun(buildRow(builds[0]!.id).threadId!, fence({ summary: 's', digest: 'd2' }));
    await h.tick();
    await settle();
    expect(h.db.select().from(contextFiles).all().every((f) => f.status === 'indexed')).toBe(true);
    expect(await continueBuilds(h.ctx, h.board.id, { onlyIfAuto: true })).toBeNull();

    // Rebuild: every file pending again, the first batch replaces the graph.
    const fresh = await startBuild(h.ctx, h.board.id, { fresh: true });
    expect(buildRow(fresh.id).fresh).toBe(true);
    expect(startMessages().at(-1)!.message).toContain('the user asked to build it again from scratch');
    h.fake.finishRun(
      buildRow(fresh.id).threadId!,
      fence({ summary: 's', digest: 'd3', nodes: [{ key: 'note-1', name: 'Note 1', type: 'term', summary: 'n', sources: [{ file: many[1]!.name }] }] }),
    );
    await h.tick();
    expect(loadGraph(h.db, h.board.id).nodes.map((n) => n.key)).toEqual(['note-1']);
  });

  it('starts a build after an upload only when the board builds on its own', async () => {
    h = await setup();
    addFile(h.ctx, h.board.id, 'a.md', text('# A'));
    h.db.update(boards).set({ contextAutoBuild: false }).where(eq(boards.id, h.board.id)).run();
    expect(await continueBuilds(h.ctx, h.board.id, { onlyIfAuto: true })).toBeNull();
    h.db.update(boards).set({ contextAutoBuild: true }).where(eq(boards.id, h.board.id)).run();
    expect(await continueBuilds(h.ctx, h.board.id, { onlyIfAuto: true })).toMatchObject({ number: 1, status: 'running' });
    expect(await continueBuilds(h.ctx, h.board.id, { onlyIfAuto: true })).toBeNull(); // one at a time
  });

  it('gives the board prompt section through knowledgeFor only when turned on', async () => {
    h = await setup();
    const board = h.db.select().from(boards).where(eq(boards.id, h.board.id)).get()!;
    expect(knowledgeFor(h.ctx, board, { text: 'x' }, 'task')).toBe('');
    addFile(h.ctx, h.board.id, 'a.md', text('# A'));
    expect(knowledgeFor(h.ctx, board, { text: 'x' }, 'task')).toContain('a.md` (not read into the graph yet)');
    expect(knowledgeFor(h.ctx, { ...board, contextInPrompts: false }, { text: 'x' }, 'task')).toBe('');
  });
});

describe('the project folder', () => {
  const folder = (repo: string) => path.join(repo, '.t3orchestra', 'context');
  type Written = {
    version: number;
    updatedAt: string;
    files: { name: string; status: string }[];
    nodes: { key: string; sources: unknown[] }[];
    edges: unknown[];
  };
  const manifest = (repo: string) => JSON.parse(fs.readFileSync(graphFilePath(repo), 'utf8')) as Written;

  it('keeps the files and graph.json in the project, and a board on another computer loads them', async () => {
    h = await setup();
    const f = addFile(h.ctx, h.board.id, 'billing.md', text(SPEC));
    expect(f.path).toBe(path.join(folder(h.repo), 'files', 'billing.md'));
    expect(manifest(h.repo)).toMatchObject({ version: 1, files: [{ name: 'billing.md', status: 'pending' }], nodes: [] });
    const b = await startBuild(h.ctx, h.board.id);
    h.fake.finishRun(buildRow(b.id).threadId!, specResult());
    await h.tick();
    const m = manifest(h.repo);
    expect(m.updatedAt).toBe(loadGraph(h.db, h.board.id).updatedAt);
    expect(m.files).toMatchObject([{ name: 'billing.md', status: 'indexed', summary: 'How payments and refunds work.' }]);
    // Files by name, not by this computer's ids.
    expect(m.nodes.find((n) => n.key === 'refund-window')!.sources).toEqual([{ file: 'billing.md', where: 'Refund window', quote: 'within 30 days' }]);
    expect(m.edges).toEqual([{ from: 'refund-window', to: 'stripe-checkout', relation: 'constrains', file: 'billing.md' }]);

    // Another computer: the project comes with the folder, the board starts empty.
    const other = await setup();
    try {
      fs.cpSync(path.join(h.repo, '.t3orchestra'), path.join(other.repo, '.t3orchestra'), { recursive: true });
      expect(syncFromProject(other.ctx, other.board.id)).toEqual({ changed: true, newPending: false });
      const files = boardKnowledge(other.ctx, other.board.id).files;
      expect(files).toMatchObject([{ name: 'billing.md', status: 'indexed', nodeCount: 2 }]);
      const g = loadGraph(other.db, other.board.id);
      expect(g.updatedAt).toBe(m.updatedAt);
      expect(g.edges[0]!.fileId).toBe(files[0]!.id);
      expect(knowledgeFor(other.ctx, other.board, { text: 'Let support refund an order' }, 'task')).toContain('**Refund window**');
      // In step now: nothing to do, and graph.json stays as it is.
      const before = fs.statSync(graphFilePath(other.repo)).mtimeMs;
      expect(syncFromProject(other.ctx, other.board.id)).toEqual({ changed: false, newPending: false });
      expect(fs.statSync(graphFilePath(other.repo)).mtimeMs).toBe(before);
    } finally {
      other.cleanup();
    }
  });

  it('follows files added, changed or deleted in the folder by hand, and a graph.json from a pull', async () => {
    h = await setup();
    const a = addFile(h.ctx, h.board.id, 'a.md', text('# A\nAlpha.'));
    const b = await startBuild(h.ctx, h.board.id);
    h.fake.finishRun(
      buildRow(b.id).threadId!,
      fence({ summary: 's', digest: 'Alpha.', files: [{ file: 'a.md', summary: 'About alpha.' }], nodes: [{ key: 'alpha', name: 'Alpha', type: 'term', summary: 'A.', sources: [{ file: 'a.md' }] }] }),
    );
    await h.tick();
    await settle();
    const dir = path.join(folder(h.repo), 'files');

    // Added by hand: waits to be read, like an upload.
    fs.writeFileSync(path.join(dir, 'b.md'), '# B');
    expect(syncFromProject(h.ctx, h.board.id)).toEqual({ changed: true, newPending: true });
    expect(manifest(h.repo).files.map((f) => [f.name, f.status])).toEqual([
      ['a.md', 'indexed'],
      ['b.md', 'pending'],
    ]);

    // Changed by hand: read again; what it said stays until then.
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\nAlpha, changed.');
    syncFromProject(h.ctx, h.board.id);
    expect(fileRow(a.id)).toMatchObject({ status: 'pending', summary: 'About alpha.' });
    expect(loadGraph(h.db, h.board.id).nodes.map((n) => n.key)).toEqual(['alpha']);

    // Deleted by hand: gone, with what it said.
    fs.rmSync(path.join(dir, 'a.md'));
    syncFromProject(h.ctx, h.board.id);
    expect(boardKnowledge(h.ctx, h.board.id).files.map((f) => f.name)).toEqual(['b.md']);
    expect(loadGraph(h.db, h.board.id).nodes).toEqual([]);

    // A graph.json from elsewhere (a pull) replaces the board's.
    const pulled = {
      ...manifest(h.repo),
      updatedAt: '2030-01-01T00:00:00.000Z',
      digest: 'From the other computer.',
      nodes: [{ key: 'beta', name: 'Beta', type: 'term', summary: 'B.', aliases: [], sources: [{ file: 'b.md', where: '', quote: '' }], code: [], updatedAt: 'x' }],
    };
    fs.writeFileSync(graphFilePath(h.repo), JSON.stringify(pulled));
    expect(syncFromProject(h.ctx, h.board.id)).toEqual({ changed: true, newPending: false });
    expect(loadGraph(h.db, h.board.id)).toMatchObject({ digest: 'From the other computer.', updatedAt: '2030-01-01T00:00:00.000Z', nodes: [{ key: 'beta' }] });

    // One that can't be read (a merge conflict) is left alone, and the page says so.
    const conflict = '<<<<<<< HEAD\n{}\n=======\n{"x":1}\n>>>>>>> theirs\n';
    fs.writeFileSync(graphFilePath(h.repo), conflict);
    expect(syncFromProject(h.ctx, h.board.id).changed).toBe(false);
    addFile(h.ctx, h.board.id, 'c.md', text('# C'));
    expect(fs.readFileSync(graphFilePath(h.repo), 'utf8')).toBe(conflict);
    expect(boardKnowledge(h.ctx, h.board.id).folderProblem).toMatch(/graph\.json can't be read: it is not valid JSON/);
  });

  it('keeps descriptions in graph.json, and reads one written before descriptions existed', async () => {
    h = await setup();
    const f = addFile(h.ctx, h.board.id, 'billing.md', text(SPEC), 'The billing spec.');
    expect(manifest(h.repo).files).toMatchObject([{ name: 'billing.md', description: 'The billing spec.' }]);
    describeFile(h.ctx, f.id, { description: 'The billing spec, signed off.', reread: false });
    expect(manifest(h.repo).files).toMatchObject([{ description: 'The billing spec, signed off.' }]);

    // Another computer gets it with the folder.
    const other = await setup();
    try {
      fs.cpSync(path.join(h.repo, '.t3orchestra'), path.join(other.repo, '.t3orchestra'), { recursive: true });
      syncFromProject(other.ctx, other.board.id);
      expect(boardKnowledge(other.ctx, other.board.id).files).toMatchObject([{ name: 'billing.md', description: 'The billing spec, signed off.' }]);
    } finally {
      other.cleanup();
    }

    // A graph.json from before: no description on its files.
    const older = JSON.parse(fs.readFileSync(graphFilePath(h.repo), 'utf8')) as { files: Array<Record<string, unknown>> };
    for (const file of older.files) delete file.description;
    fs.writeFileSync(graphFilePath(h.repo), JSON.stringify({ ...older, updatedAt: '2030-01-01T00:00:00.000Z' }));
    expect(syncFromProject(h.ctx, h.board.id).changed).toBe(true);
    expect(fileRow(f.id)).toMatchObject({ description: null, status: 'pending' });
  });

  it('leaves out a file over the limit put in the folder by hand, and says so', async () => {
    h = await setup();
    addFile(h.ctx, h.board.id, 'a.md', text('# A'));
    const big = path.join(folder(h.repo), 'files', 'scan.pdf');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, MAX_KNOWLEDGE_FILE_BYTES + 1);
    expect(syncFromProject(h.ctx, h.board.id).changed).toBe(false);
    const view = boardKnowledge(h.ctx, h.board.id);
    expect(view.files.map((f) => f.name)).toEqual(['a.md']);
    expect(view.folderProblem).toBe('scan.pdf is over 100 MB, so the board leaves it out of the graph.');
  });

  it('moves files kept outside the project before into it', async () => {
    h = await setup();
    const old = legacyContextDir(h.tmp, h.board.id);
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'spec.md'), SPEC);
    const sha256 = createHash('sha256').update(SPEC).digest('hex');
    h.db
      .insert(contextFiles)
      .values({ id: 'f-old', boardId: h.board.id, name: 'spec.md', size: SPEC.length, sha256, status: 'indexed', summary: 'Old.', note: null, uploadedAt: 'then', updatedAt: 'then' })
      .run();
    expect(syncFromProject(h.ctx, h.board.id).changed).toBe(false);
    expect(fs.readFileSync(path.join(folder(h.repo), 'files', 'spec.md'), 'utf8')).toBe(SPEC);
    expect(fs.existsSync(old)).toBe(false);
    expect(manifest(h.repo).files).toMatchObject([{ name: 'spec.md', status: 'indexed' }]);
    expect(syncFromProject(h.ctx, h.board.id).changed).toBe(false);
    expect(fileRow('f-old').status).toBe('indexed');
  });
});

describe('context HTTP routes', () => {
  const PORT = 4417;
  const HOST = { host: `127.0.0.1:${PORT}` };

  it('uploads, lists, serves and deletes files', async () => {
    h = await setup();
    const app = createApp({ engine: h.engine, port: PORT });
    const put = await app.request(`/api/boards/${h.board.id}/context/files?name=${encodeURIComponent('spec <v2>.md')}`, {
      method: 'PUT',
      headers: { ...HOST, 'X-T3Orchestra': '1', 'Content-Type': 'application/octet-stream' },
      body: SPEC,
    });
    expect(put.status).toBe(201);
    const file = (await put.json()) as { id: string; name: string; url: string };
    expect(file.name).toBe('spec _v2_.md');

    const list = (await (await app.request(`/api/boards/${h.board.slug}/context`, { headers: HOST })).json()) as {
      files: unknown[];
      graph: { nodes: unknown[] };
      folder: string;
      git: unknown;
    };
    expect(list.files).toHaveLength(1);
    expect(list.graph.nodes).toEqual([]);
    // The file and graph.json, not committed yet.
    expect(list.folder).toBe('.t3orchestra/context');
    expect(list.git).toEqual({ changes: 2, ignored: false });

    const raw = await app.request(file.url, { headers: HOST });
    expect(raw.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(raw.headers.get('content-security-policy')).toBe('sandbox');
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await raw.text()).toBe(SPEC);

    const preview = (await (await app.request(`/api/boards/${h.board.id}/context/preview?q=refund`, { headers: HOST })).json()) as { text: string };
    expect(preview.text).toContain('## Project knowledge');

    const auto = await app.request(`/api/boards/${h.board.id}/context/auto-build`, { method: 'POST', headers: { ...HOST, 'X-T3Orchestra': '1' } });
    expect(((await auto.json()) as { build: { number: number } | null }).build).toMatchObject({ number: 1 });

    const del = await app.request(`/api/context/files/${file.id}`, { method: 'DELETE', headers: { ...HOST, 'X-T3Orchestra': '1' } });
    expect(del.status).toBe(200);
    expect((await app.request(file.url, { headers: HOST })).status).toBe(404);
  });

  it('takes a description with the upload and edits it later', async () => {
    h = await setup();
    const app = createApp({ engine: h.engine, port: PORT });
    const desc = 'Τα σημαντικά: the refund rules, section 4.';
    const put = await app.request(`/api/boards/${h.board.id}/context/files?name=spec.md&description=${encodeURIComponent(desc)}`, {
      method: 'PUT',
      headers: { ...HOST, 'X-T3Orchestra': '1', 'Content-Type': 'application/octet-stream' },
      body: SPEC,
    });
    const file = (await put.json()) as { id: string; description: string | null };
    expect(file.description).toBe(desc);

    const patch = (body: unknown) =>
      app.request(`/api/context/files/${file.id}`, {
        method: 'PATCH',
        headers: { ...HOST, 'X-T3Orchestra': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const res = await patch({ description: 'Just the refund rules.' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: file.id, description: 'Just the refund rules.', status: 'pending' });
    expect((await patch({ description: null })).status).toBe(200);
    expect(boardKnowledge(h.ctx, h.board.id).files[0]!.description).toBeNull();
    expect((await patch({ description: 'x'.repeat(1001) })).status).toBe(400);
  });

  it('reads a file over the limit to the end before refusing it, with or without a length', async () => {
    h = await setup();
    const app = createApp({ engine: h.engine, port: PORT });
    const mb = new Uint8Array(1024 * 1024);
    let pulled = 0;
    // Sent in 1 MB pieces with no Content-Length, like a stream.
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled++ < MAX_KNOWLEDGE_FILE_BYTES / mb.length + 1) c.enqueue(mb);
        else c.close();
      },
    });
    const res = await app.request(`/api/boards/${h.board.id}/context/files?name=scan.pdf`, {
      method: 'PUT',
      headers: { ...HOST, 'X-T3Orchestra': '1', 'Content-Type': 'application/octet-stream' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('The file is larger than 100 MB.');
    expect(pulled).toBe(MAX_KNOWLEDGE_FILE_BYTES / mb.length + 2);
    expect(boardKnowledge(h.ctx, h.board.id).files).toEqual([]);

    // Right at the limit is fine.
    const ok = await app.request(`/api/boards/${h.board.id}/context/files?name=max.pdf`, {
      method: 'PUT',
      headers: { ...HOST, 'X-T3Orchestra': '1', 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(MAX_KNOWLEDGE_FILE_BYTES),
    });
    expect(ok.status).toBe(201);
  });
});
