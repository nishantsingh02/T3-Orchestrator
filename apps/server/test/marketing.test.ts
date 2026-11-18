import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { execa } from 'execa';
import { ideaBatches, marketingSnapshots, marketingSources } from '../src/db/schema.ts';
import { boardIdeas } from '../src/db/views.ts';
import { patchBoard } from '../src/engine/boards.ts';
import { addIdeaToBoard, dismissIdea, generateIdeas, markIdeaDone } from '../src/engine/ideas.ts';
import { addSource, boardMarketing, logValue, MarketingRefresher, metricsText, refreshSource, removeSource, sourceView, updateSource } from '../src/marketing/service.ts';
import { atPath, normalizeSource, parseGithubRepo } from '../src/marketing/sources.ts';
import { fence, setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

type Call = { url: string; init: RequestInit };

/** A fetch that answers from `routes` (matched by URL prefix) and records every call. */
function fakeFetch(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes)
      .filter((k) => url.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const r = routes[key];
    const body = typeof r === 'function' ? (r as (c: Call) => unknown)({ url, init }) : r;
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const repo = { stargazers_count: 120, forks_count: 8, subscribers_count: 5, open_issues_count: 3 };
const header = (c: Call, name: string) => (c.init.headers as Record<string, string> | undefined)?.[name];

describe('marketing sources', () => {
  it('reads a GitHub repo, keeps the token on the server, and adds traffic when the token allows it', async () => {
    h = await setup();
    const f = fakeFetch({
      'https://api.github.com/repos/acme/rocket/releases': [{ assets: [{ download_count: 40 }, { download_count: 2 }] }],
      'https://api.github.com/repos/acme/rocket/traffic/views': { count: 300, uniques: 90 },
      'https://api.github.com/repos/acme/rocket/traffic/clones': new Response('{"message":"Must have push access"}', { status: 403 }),
      'https://api.github.com/repos/acme/rocket': repo,
    });
    h.ctx.fetch = f.fn;
    const row = await addSource(h.ctx, h.board.id, { kind: 'github', config: { repo: 'https://github.com/acme/rocket.git' }, secret: 'ghp_secret' });

    expect(row).toMatchObject({ name: 'acme/rocket', config: { repo: 'acme/rocket' }, status: 'ok', secret: 'ghp_secret' });
    expect(header(f.calls[0]!, 'Authorization')).toBe('Bearer ghp_secret');
    const v = sourceView(h.db, row);
    expect(v.hasSecret).toBe(true);
    expect(JSON.stringify(v)).not.toContain('ghp_secret');
    expect(Object.fromEntries(v.metrics.map((m) => [m.key, m.value]))).toEqual({
      stars: 120,
      forks: 8,
      watchers: 5,
      open_issues: 3,
      release_downloads: 42,
      views_14d: 300,
      visitors_14d: 90,
    });
  });

  it("doesn't save a source whose first read fails, or a second copy of one", async () => {
    h = await setup();
    h.ctx.fetch = fakeFetch({}).fn;
    await expect(addSource(h.ctx, h.board.id, { kind: 'npm', config: { package: 'nope' } })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('Not found: check the name (HTTP 404)'),
    });
    await expect(addSource(h.ctx, h.board.id, { kind: 'plausible', config: { site: 'x.com' } })).rejects.toThrow(/Stats API key is required/);
    await expect(addSource(h.ctx, h.board.id, { kind: 'github', config: { repo: 'not a repo' } })).rejects.toThrow(/owner\/repo/);
    expect(h.db.select().from(marketingSources).all()).toEqual([]);

    h.ctx.fetch = fakeFetch({ 'https://api.npmjs.org/downloads/point/': { downloads: 10 } }).fn;
    await addSource(h.ctx, h.board.id, { kind: 'npm', config: { package: '@acme/rocket' } });
    await expect(addSource(h.ctx, h.board.id, { kind: 'npm', config: { package: '@ACME/rocket' } })).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('queries Plausible and PostHog with their keys', async () => {
    h = await setup();
    const f = fakeFetch({
      'https://stats.example.com/api/v2/query': { results: [{ metrics: [1200, 3400, 41, 95], dimensions: [] }] },
      'https://eu.posthog.com/api/projects/42/query/': (c: Call) =>
        String(c.init.body).includes("'signed_up'") ? { results: [[17]] } : { results: [[5000, 800]] },
    });
    h.ctx.fetch = f.fn;
    const p = await addSource(h.ctx, h.board.id, { kind: 'plausible', config: { site: 'https://rocket.dev/', host: 'stats.example.com' }, secret: 'pk' });
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ site_id: 'rocket.dev', metrics: ['visitors', 'pageviews', 'bounce_rate', 'visit_duration'], date_range: '30d' });
    expect(Object.fromEntries(sourceView(h.db, p).metrics.map((m) => [m.key, [m.value, m.unit]]))).toEqual({
      visitors_30d: [1200, 'count'],
      pageviews_30d: [3400, 'count'],
      bounce_rate: [41, 'percent'],
      visit_duration: [95, 'seconds'],
    });

    const ph = await addSource(h.ctx, h.board.id, { kind: 'posthog', config: { projectId: '42', host: 'https://eu.posthog.com', signupEvent: 'signed_up' }, secret: 'phx' });
    expect(header(f.calls.at(-1)!, 'Authorization')).toBe('Bearer phx');
    expect(Object.fromEntries(sourceView(h.db, ph).metrics.map((m) => [m.key, m.value]))).toEqual({ pageviews_30d: 5000, visitors_30d: 800, signups_30d: 17 });
  });

  it('keeps a failed refresh on the source, and recovers on the next one', async () => {
    h = await setup();
    let down = false;
    h.ctx.fetch = fakeFetch({
      'https://hub.docker.com/v2/repositories/library/redis/': () => (down ? new Response('busy', { status: 503 }) : { pull_count: 1000, star_count: 12 }),
    }).fn;
    const row = await addSource(h.ctx, h.board.id, { kind: 'docker', config: { image: 'redis' } });
    expect(row.name).toBe('library/redis');
    expect(() => logValue(h.ctx, row.id, 5)).toThrow(/refresh it instead/);
    down = true;
    const failed = await refreshSource(h.ctx, row.id);
    expect(failed).toMatchObject({ status: 'error', error: 'The request failed (HTTP 503): busy.' });
    // The last good numbers stay on the card.
    expect(sourceView(h.db, failed).metrics.find((m) => m.key === 'pulls')!.value).toBe(1000);
    down = false;
    expect(await refreshSource(h.ctx, row.id)).toMatchObject({ status: 'ok', error: null });
  });

  it('compares with a week ago and keeps one point per day', async () => {
    h = await setup();
    const row = await addSource(h.ctx, h.board.id, { kind: 'manual', config: { label: 'Newsletter subscribers' } });
    expect(row).toMatchObject({ status: 'new', name: 'Newsletter subscribers' });
    const now = Date.parse('2026-11-07T12:00:00Z');
    const day = (d: number, hour = 9) => new Date(now - d * 86_400_000 + (hour - 12) * 3_600_000).toISOString();
    for (const [at, value] of [
      [day(10), 50],
      [day(8), 70],
      [day(3), 90],
      [day(0, 8), 95],
      [day(0, 11), 100],
    ] as const) {
      h.db.insert(marketingSnapshots).values({ sourceId: row.id, metric: 'value', value, takenAt: at }).run();
    }
    const [m] = sourceView(h.db, row, now).metrics;
    expect(m).toMatchObject({ label: 'Newsletter subscribers', value: 100, baseline: { value: 70, at: day(8) } });
    expect(m!.points.map((p) => p.value)).toEqual([50, 70, 90, 100]);
    expect(metricsText(h.ctx, h.board.id, now)).toBe('- Manual (Newsletter subscribers): Newsletter subscribers 100 (+30 in 8d)');

    logValue(h.ctx, row.id, 120);
    expect(sourceView(h.db, h.db.select().from(marketingSources).get()!).metrics[0]!.value).toBe(120);
    const young = await addSource(h.ctx, h.board.id, { kind: 'manual', config: { label: 'Waitlist' } });
    logValue(h.ctx, young.id, 3);
    logValue(h.ctx, young.id, 5);
    expect(sourceView(h.db, h.db.select().from(marketingSources).where(eq(marketingSources.id, young.id)).get()!).metrics[0]!.baseline).toBeNull();
    expect(() => logValue(h.ctx, 'missing', 1)).toThrow(/not found/);
  });

  it('edits a source: keeps the secret unless told, and starts the history over for a new target', async () => {
    h = await setup();
    const f = fakeFetch({
      'https://api.github.com/repos/acme/rocket': repo,
      'https://api.github.com/repos/acme/other': { ...repo, stargazers_count: 3 },
    });
    h.ctx.fetch = f.fn;
    const row = await addSource(h.ctx, h.board.id, { kind: 'github', name: 'Our repo', config: { repo: 'acme/rocket' }, secret: 'tok' });
    expect((await updateSource(h.ctx, row.id, { name: 'Rocket' })).secret).toBe('tok');
    expect(h.db.select().from(marketingSnapshots).all().length).toBeGreaterThan(0);

    const moved = await updateSource(h.ctx, row.id, { config: { repo: 'acme/other' }, secret: null });
    expect(moved).toMatchObject({ secret: null, name: 'acme/other' });
    expect(header(f.calls.at(-1)!, 'Authorization')).toBeUndefined();
    expect(sourceView(h.db, moved).metrics.find((m) => m.key === 'stars')!.value).toBe(3);
    expect(h.db.select().from(marketingSnapshots).all().every((s) => s.value !== 120)).toBe(true);

    removeSource(h.ctx, row.id);
    expect(h.db.select().from(marketingSources).all()).toEqual([]);
    expect(h.db.select().from(marketingSnapshots).all()).toEqual([]);
  });

  it('refreshes sources not read for six hours, and never manual ones', async () => {
    h = await setup();
    h.ctx.fetch = fakeFetch({ 'https://hn.algolia.com/api/v1/search': { nbHits: 2, hits: [{ points: 30, num_comments: 4 }, { points: 5, num_comments: 1 }] } }).fn;
    const hn = await addSource(h.ctx, h.board.id, { kind: 'hackernews', config: { query: 'rocket.dev' } });
    expect(Object.fromEntries(sourceView(h.db, hn).metrics.map((m) => [m.key, m.value]))).toEqual({ stories_30d: 2, points_30d: 35, comments_30d: 5 });
    await addSource(h.ctx, h.board.id, { kind: 'manual', config: { label: 'Followers' } });
    const refresher = new MarketingRefresher(h.ctx);
    expect(await refresher.tick()).toBe(0);
    expect(await refresher.tick(Date.now() + 7 * 3_600_000)).toBe(1);
  });

  it('suggests the GitHub remote and a public npm package from the project', async () => {
    h = await setup();
    await execa('git', ['-C', h.repo, 'remote', 'add', 'origin', 'git@github.com:acme/rocket.git']);
    fs.writeFileSync(path.join(h.repo, 'package.json'), JSON.stringify({ name: 'rocket-cli', version: '1.0.0' }));
    const v = await boardMarketing(h.ctx, h.board.id);
    expect(v.suggestions.map((s) => [s.kind, s.config])).toEqual([
      ['github', { repo: 'acme/rocket' }],
      ['hackernews', { query: 'github.com/acme/rocket' }],
      ['npm', { package: 'rocket-cli' }],
    ]);
  });

  it('parses repos and JSON paths', () => {
    expect(parseGithubRepo('acme/rocket')).toBe('acme/rocket');
    expect(parseGithubRepo('https://www.github.com/acme/rocket/')).toBe('acme/rocket');
    expect(parseGithubRepo('git@github.com:acme/rocket.js.git')).toBe('acme/rocket.js');
    expect(parseGithubRepo('https://gitlab.com/acme/rocket')).toBeNull();
    expect(atPath({ data: { items: [{ count: 4 }] } }, 'data.items.0.count')).toBe(4);
    expect(normalizeSource('json', { label: 'MRR', url: 'https://x.dev/s', path: 'mrr' }, 'Bearer k')).toMatchObject({
      config: { label: 'MRR', url: 'https://x.dev/s', path: 'mrr', header: 'Authorization' },
      secret: 'Bearer k',
    });
  });
});

const task = (title: string, o: Record<string, unknown> = {}) => ({
  kind: 'build',
  title,
  description: `Why ${title} helps.`,
  details: `Change \`src/${title}.ts\`.`,
  draft: '',
  acceptanceCriteria: [`${title} works`],
  touches: [`src/${title}.ts`],
  impact: 'high',
  difficulty: 'easy',
  ...o,
});
const batchOf = (id: string) => h.db.select().from(ideaBatches).where(eq(ideaBatches.id, id)).get()!;

describe('marketing tasks', () => {
  it('prompts with the brief and metrics, and keeps build and do tasks apart', async () => {
    h = await setup();
    h.ctx.fetch = fakeFetch({ 'https://api.github.com/repos/acme/rocket': repo }).fn;
    await addSource(h.ctx, h.board.id, { kind: 'github', config: { repo: 'acme/rocket' } });
    const batch = await generateIdeas(h.ctx, h.board.id, 'launch');

    const start = h.fake.calls.find((c) => c.op === 'start')!.args as { title: string; message: string };
    expect(start.title).toMatch(/^Marketing #1: Launch & announcements \[tb \w+ idea-1\]$/);
    expect(start.message).toMatch(/^You are the Marketing agent/);
    expect(start.message).toContain('## Focus: Launch & announcements');
    expect(start.message).toContain('- GitHub (acme/rocket): Stars 120, Forks 8');
    expect(start.message).toContain('write that as a short brief');

    h.fake.finishRun(
      batchOf(batch.id).threadId!,
      fence({
        summary: 'Read the README.',
        suggestedBrief: 'Rocket ships static sites.',
        ideas: [task('Add a changelog page'), task('Post a Show HN', { kind: 'do', draft: 'Show HN: Rocket', acceptanceCriteria: [], touches: [] })],
      }),
    );
    await h.tick();
    const v = boardIdeas(h.db, h.board.id);
    expect(v.batches[0]).toMatchObject({ status: 'done', category: 'launch', suggestedBrief: 'Rocket ships static sites.', ideaCount: 2 });
    const [build, todo] = v.ideas;
    expect([build!.kind, todo!.kind, todo!.draft]).toEqual(['build', 'do', 'Show HN: Rocket']);

    expect(() => addIdeaToBoard(h.ctx, todo!.id)).toThrow(/mark it done/);
    expect(() => markIdeaDone(h.ctx, build!.id, false)).toThrow(/add it to the board/);
    expect(markIdeaDone(h.ctx, todo!.id, false).status).toBe('done');
    expect(() => dismissIdea(h.ctx, todo!.id, false)).toThrow(/already done/);
    expect(markIdeaDone(h.ctx, todo!.id, true).status).toBe('new');
    const { task: t } = addIdeaToBoard(h.ctx, build!.id);
    expect(t).toMatchObject({ stage: 'backlog', category: 'docs' });
    expect(t.description).toContain('_From Marketing (Launch & announcements)');

    // With a brief, the agent is not asked for one; earlier tasks are listed.
    await patchBoard(h.ctx, h.board.id, { marketingBrief: 'Rocket: static sites in one command.' });
    markIdeaDone(h.ctx, todo!.id, false);
    await generateIdeas(h.ctx, h.board.id, 'launch');
    const next = (h.fake.calls.filter((c) => c.op === 'start').at(-1)!.args as { message: string }).message;
    expect(next).toContain('Rocket: static sites in one command.');
    expect(next).not.toContain('write that as a short brief');
    expect(next).toContain('- Post a Show HN (done by the team)');
    expect(next).toContain('- Add a changelog page (on the board as #1)');
  });

  it('asks for a correction when a marketing task has no kind', async () => {
    h = await setup();
    const batch = await generateIdeas(h.ctx, h.board.id, 'seo');
    const threadId = batchOf(batch.id).threadId!;
    h.fake.finishRun(threadId, fence({ ideas: [task('Add meta tags', { kind: undefined })] }));
    await h.tick();
    expect(h.fake.calls.filter((c) => c.op === 'send')).toHaveLength(1);
    h.fake.finishRun(threadId, fence({ ideas: [task('Add meta tags')] }));
    await h.tick();
    expect(boardIdeas(h.db, h.board.id).batches[0]).toMatchObject({ status: 'done', ideaCount: 1, suggestedBrief: null });
  });
});
