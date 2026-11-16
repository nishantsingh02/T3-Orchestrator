// Marketing metrics: connected sources, their snapshots over time, and the background refresh.
import fs from 'node:fs';
import path from 'node:path';
import {
  metricDefs,
  SOURCE_KIND_INFO,
  type BoardMarketingView,
  type CreateMarketingSourceBody,
  type MarketingMetricView,
  type MarketingSourceKind,
  type MarketingSourceView,
  type MetricPoint,
  type MetricUnit,
  type PatchMarketingSourceBody,
  type SourceSuggestion,
} from '@t3-orchestra/shared';
import { and, asc, eq, gte, isNull, lt, ne, or } from 'drizzle-orm';
import { execa } from 'execa';
import type { Db } from '../db/client.ts';
import { boards, marketingSnapshots, marketingSources, type BoardRow, type MarketingSourceRow } from '../db/schema.ts';
import { AppError, getBoardOrThrow, type DbOrTx, type EngineContext } from '../engine/context.ts';
import { childLog } from '../log.ts';
import { errorMessage, newId, nowIso } from '../util.ts';
import { fetchMetrics, normalizeSource, parseGithubRepo, SourceError } from './sources.ts';

const log = childLog('marketing');

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 90;
/** Background refresh: each fetched source about this often. */
const REFRESH_EVERY_MS = 6 * 60 * 60_000;
const CHECK_EVERY_MS = 30 * 60_000;

/** Fields that say *what* is measured; changing one starts the history over. */
const IDENTITY: Record<MarketingSourceKind, string[]> = {
  github: ['repo'],
  plausible: ['site', 'host'],
  posthog: ['projectId', 'host'],
  npm: ['package'],
  pypi: ['package'],
  docker: ['image'],
  hackernews: ['query'],
  json: ['url', 'path'],
  manual: [],
};

function getSourceOrThrow(ctx: EngineContext, id: string): MarketingSourceRow {
  const s = ctx.db.select().from(marketingSources).where(eq(marketingSources.id, id)).get();
  if (!s) throw new AppError('NOT_FOUND', `metric source ${id} not found`, 404);
  return s;
}

function lastWhere<T>(list: T[], fn: (v: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (fn(list[i]!)) return list[i];
  return undefined;
}

export function sourceView(db: Db, row: MarketingSourceRow, nowMs = Date.now()): MarketingSourceView {
  const since = new Date(nowMs - HISTORY_DAYS * DAY_MS).toISOString();
  const snaps = db
    .select()
    .from(marketingSnapshots)
    .where(and(eq(marketingSnapshots.sourceId, row.id), gte(marketingSnapshots.takenAt, since)))
    .orderBy(asc(marketingSnapshots.takenAt), asc(marketingSnapshots.id))
    .all();
  const byMetric = new Map<string, typeof snaps>();
  for (const s of snaps) byMetric.set(s.metric, [...(byMetric.get(s.metric) ?? []), s]);

  const metrics: MarketingMetricView[] = [];
  for (const def of metricDefs(row.kind, row.config)) {
    const list = byMetric.get(def.key);
    if (!list?.length) continue;
    const latest = list.at(-1)!;
    const latestMs = Date.parse(latest.takenAt);
    // A week back; a younger history compares with its first value once that is a day old.
    let base = lastWhere(list, (s) => Date.parse(s.takenAt) <= latestMs - 7 * DAY_MS);
    if (!base && latestMs - Date.parse(list[0]!.takenAt) >= DAY_MS) base = list[0];
    const points: MetricPoint[] = [];
    for (const s of list) {
      const day = s.takenAt.slice(0, 10);
      if (points.at(-1)?.day === day) points.at(-1)!.value = s.value;
      else points.push({ day, value: s.value });
    }
    metrics.push({ ...def, value: latest.value, at: latest.takenAt, baseline: base ? { value: base.value, at: base.takenAt } : null, points });
  }
  return {
    id: row.id,
    boardId: row.boardId,
    kind: row.kind,
    name: row.name,
    config: row.config ?? {},
    hasSecret: Boolean(row.secret),
    status: row.status,
    error: row.error,
    lastFetchedAt: row.lastFetchedAt,
    createdAt: row.createdAt,
    metrics,
  };
}

function emitSource(ctx: EngineContext, id: string): void {
  const row = ctx.db.select().from(marketingSources).where(eq(marketingSources.id, id)).get();
  if (row) ctx.bus.emit('marketing_source', sourceView(ctx.db, row));
}

function boardSources(db: Db, boardId: string): MarketingSourceRow[] {
  return db.select().from(marketingSources).where(eq(marketingSources.boardId, boardId)).orderBy(asc(marketingSources.createdAt)).all();
}

/** Sources found in the project that aren't connected yet: the GitHub remote, a public npm package. */
export async function detectSuggestions(board: BoardRow, sources: MarketingSourceRow[]): Promise<SourceSuggestion[]> {
  const has = (kind: MarketingSourceKind, key: string, value: string) =>
    sources.some((s) => s.kind === kind && (s.config?.[key] ?? '').toLowerCase() === value.toLowerCase());
  const out: SourceSuggestion[] = [];
  const remote = await execa('git', ['-C', board.projectPath, 'remote', 'get-url', 'origin'], { reject: false, timeout: 5000 });
  const url = remote.exitCode === 0 ? String(remote.stdout).trim() : '';
  const repo = /github\.com/i.test(url) ? parseGithubRepo(url) : null;
  if (repo) {
    if (!has('github', 'repo', repo)) out.push({ kind: 'github', name: repo, config: { repo }, reason: 'the git remote' });
    const query = `github.com/${repo}`;
    if (!sources.some((s) => s.kind === 'hackernews')) out.push({ kind: 'hackernews', name: `HN: ${query}`, config: { query }, reason: 'the git remote' });
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(board.projectPath, 'package.json'), 'utf8')) as { name?: unknown; private?: unknown };
    if (typeof pkg.name === 'string' && pkg.name && pkg.private !== true && !has('npm', 'package', pkg.name)) {
      out.push({ kind: 'npm', name: pkg.name, config: { package: pkg.name }, reason: 'package.json' });
    }
  } catch {
    // no package.json, or not JSON
  }
  return out;
}

export async function boardMarketing(ctx: EngineContext, boardId: string): Promise<BoardMarketingView> {
  const board = getBoardOrThrow(ctx, boardId);
  const rows = boardSources(ctx.db, boardId);
  const suggestions = await detectSuggestions(board, rows).catch((err) => {
    log.warn({ boardId, err: errorMessage(err) }, 'could not look for metric sources in the project');
    return [];
  });
  return { sources: rows.map((r) => sourceView(ctx.db, r)), suggestions };
}

function normalizeOrThrow(...args: Parameters<typeof normalizeSource>) {
  try {
    return normalizeSource(...args);
  } catch (err) {
    if (err instanceof SourceError) throw new AppError('VALIDATION', err.message);
    throw err;
  }
}

/** Reads the numbers once before saving, so a typo shows in the form instead of on the card. */
async function readOrThrow(ctx: EngineContext, kind: MarketingSourceKind, config: Record<string, string>, secret: string | null) {
  try {
    return await fetchMetrics(ctx.fetch, kind, config, secret);
  } catch (err) {
    if (err instanceof SourceError) throw new AppError('VALIDATION', `Could not read ${SOURCE_KIND_INFO[kind].label}: ${err.message}`);
    throw err;
  }
}

function insertValues(tx: DbOrTx, sourceId: string, values: Record<string, number>, takenAt: string): void {
  for (const [metric, value] of Object.entries(values)) tx.insert(marketingSnapshots).values({ sourceId, metric, value, takenAt }).run();
}

export async function addSource(ctx: EngineContext, boardId: string, body: CreateMarketingSourceBody): Promise<MarketingSourceRow> {
  getBoardOrThrow(ctx, boardId);
  const info = SOURCE_KIND_INFO[body.kind];
  const n = normalizeOrThrow(body.kind, body.config, body.secret ?? null);
  const identity = IDENTITY[body.kind];
  const twin = boardSources(ctx.db, boardId).find(
    (s) => s.kind === body.kind && identity.length > 0 && identity.every((k) => (s.config?.[k] ?? '') === (n.config[k] ?? '')),
  );
  if (twin) throw new AppError('ILLEGAL_TRANSITION', `${info.label} ${twin.name} is already connected.`, 409);
  const values = info.fetched ? await readOrThrow(ctx, body.kind, n.config, n.secret) : null;
  const now = nowIso();
  const row: MarketingSourceRow = {
    id: newId(),
    boardId,
    kind: body.kind,
    name: body.name?.trim() || n.name,
    config: n.config,
    secret: n.secret,
    status: values ? 'ok' : 'new',
    error: null,
    lastFetchedAt: values ? now : null,
    createdAt: now,
    updatedAt: now,
  };
  ctx.db.transaction((tx) => {
    tx.insert(marketingSources).values(row).run();
    if (values) insertValues(tx, row.id, values, now);
  });
  log.info({ boardId, kind: row.kind, metrics: Object.keys(values ?? {}) }, 'metric source connected');
  emitSource(ctx, row.id);
  return getSourceOrThrow(ctx, row.id);
}

export async function updateSource(ctx: EngineContext, id: string, body: PatchMarketingSourceBody): Promise<MarketingSourceRow> {
  const row = getSourceOrThrow(ctx, id);
  const info = SOURCE_KIND_INFO[row.kind];
  const n = normalizeOrThrow(row.kind, body.config ?? row.config, body.secret, row.secret);
  const configChanged = JSON.stringify(n.config) !== JSON.stringify(row.config) || n.secret !== row.secret;
  const restart = IDENTITY[row.kind].some((k) => (n.config[k] ?? '') !== (row.config?.[k] ?? ''));
  const values = info.fetched && configChanged ? await readOrThrow(ctx, row.kind, n.config, n.secret) : null;
  const now = nowIso();
  const name = body.name !== undefined ? body.name.trim() || n.name : restart ? n.name : row.name;
  ctx.db.transaction((tx) => {
    if (restart) tx.delete(marketingSnapshots).where(eq(marketingSnapshots.sourceId, id)).run();
    tx.update(marketingSources)
      .set({
        name,
        config: n.config,
        secret: n.secret,
        updatedAt: now,
        ...(values ? { status: 'ok' as const, error: null, lastFetchedAt: now } : restart ? { status: 'new' as const, error: null, lastFetchedAt: null } : {}),
      })
      .where(eq(marketingSources.id, id))
      .run();
    if (values) insertValues(tx, id, values, now);
  });
  emitSource(ctx, id);
  return getSourceOrThrow(ctx, id);
}

export function removeSource(ctx: EngineContext, id: string): void {
  const row = getSourceOrThrow(ctx, id);
  ctx.db.transaction((tx) => {
    tx.delete(marketingSnapshots).where(eq(marketingSnapshots.sourceId, id)).run();
    tx.delete(marketingSources).where(eq(marketingSources.id, id)).run();
  });
  ctx.bus.emit('marketing_source_removed', { id, boardId: row.boardId });
}

const inFlight = new Map<string, Promise<MarketingSourceRow>>();

/** Fetches the source's numbers now. A failure is kept on the source (status `error`), not thrown. */
export function refreshSource(ctx: EngineContext, id: string): Promise<MarketingSourceRow> {
  const running = inFlight.get(id);
  if (running) return running;
  const p = (async () => {
    const row = getSourceOrThrow(ctx, id);
    if (!SOURCE_KIND_INFO[row.kind].fetched) return row;
    let values: Record<string, number> | null = null;
    let error: string | null = null;
    try {
      values = await fetchMetrics(ctx.fetch, row.kind, row.config, row.secret);
    } catch (err) {
      error = err instanceof SourceError ? err.message : `Unexpected error: ${errorMessage(err)}`;
    }
    // Removed while fetching.
    if (!ctx.db.select({ id: marketingSources.id }).from(marketingSources).where(eq(marketingSources.id, id)).get()) return row;
    const now = nowIso();
    ctx.db.transaction((tx) => {
      if (values) insertValues(tx, id, values, now);
      tx.update(marketingSources).set({ status: error ? 'error' : 'ok', error, lastFetchedAt: now, updatedAt: now }).where(eq(marketingSources.id, id)).run();
    });
    if (error) log.warn({ sourceId: id, kind: row.kind, error }, 'metric source could not be read');
    emitSource(ctx, id);
    return getSourceOrThrow(ctx, id);
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

export async function refreshBoardSources(ctx: EngineContext, boardId: string): Promise<MarketingSourceRow[]> {
  getBoardOrThrow(ctx, boardId);
  const rows = boardSources(ctx.db, boardId).filter((r) => SOURCE_KIND_INFO[r.kind].fetched);
  return Promise.all(rows.map((r) => refreshSource(ctx, r.id)));
}

/** Logs a value of a manual metric. */
export function logValue(ctx: EngineContext, id: string, value: number): MarketingSourceRow {
  const row = getSourceOrThrow(ctx, id);
  if (SOURCE_KIND_INFO[row.kind].fetched) throw new AppError('ILLEGAL_TRANSITION', `${row.name} is read from ${SOURCE_KIND_INFO[row.kind].label}; refresh it instead.`, 409);
  const now = nowIso();
  ctx.db.transaction((tx) => {
    insertValues(tx, id, { value }, now);
    tx.update(marketingSources).set({ status: 'ok', error: null, lastFetchedAt: now, updatedAt: now }).where(eq(marketingSources.id, id)).run();
  });
  emitSource(ctx, id);
  return getSourceOrThrow(ctx, id);
}

function plain(v: number, unit: MetricUnit): string {
  const r = Math.round(v * 10) / 10;
  if (unit === 'percent') return `${r}%`;
  if (unit === 'seconds') return `${Math.round(v)}s`;
  return r.toLocaleString('en-US');
}

/** The board's metrics for the Marketing agent's prompt. */
export function metricsText(ctx: EngineContext, boardId: string, nowMs = Date.now()): string {
  const lines: string[] = [];
  for (const row of boardSources(ctx.db, boardId)) {
    const v = sourceView(ctx.db, row, nowMs);
    const label = `${SOURCE_KIND_INFO[v.kind].label} (${v.name})`;
    if (v.metrics.length === 0) {
      lines.push(`- ${label}: ${v.status === 'error' ? `could not be read (${v.error})` : 'no values yet'}`);
      continue;
    }
    const parts = v.metrics.map((m) => {
      if (!m.baseline || m.baseline.value === m.value) return `${m.label} ${plain(m.value, m.unit)}`;
      const days = Math.max(1, Math.round((Date.parse(m.at) - Date.parse(m.baseline.at)) / DAY_MS));
      const d = m.value - m.baseline.value;
      return `${m.label} ${plain(m.value, m.unit)} (${d > 0 ? '+' : '-'}${plain(Math.abs(d), m.unit)} in ${days}d)`;
    });
    lines.push(`- ${label}: ${parts.join(', ')}`);
  }
  return lines.length ? lines.join('\n') : '(no metrics connected yet)';
}

/** Refreshes every fetched source on a live board about every six hours. */
export class MarketingRefresher {
  private first: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly ctx: EngineContext) {}

  start(): void {
    this.first = setTimeout(() => void this.tick(), 60_000);
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** Refreshes the sources not fetched for six hours, one at a time. */
  async tick(nowMs = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const cutoff = new Date(nowMs - REFRESH_EVERY_MS).toISOString();
      const due = this.ctx.db
        .select({ id: marketingSources.id })
        .from(marketingSources)
        .innerJoin(boards, eq(boards.id, marketingSources.boardId))
        .where(
          and(
            isNull(boards.archivedAt),
            ne(marketingSources.kind, 'manual'),
            or(isNull(marketingSources.lastFetchedAt), lt(marketingSources.lastFetchedAt, cutoff)),
          ),
        )
        .all();
      for (const { id } of due) await refreshSource(this.ctx, id).catch((err) => log.warn({ sourceId: id, err: errorMessage(err) }, 'refresh failed'));
      return due.length;
    } finally {
      this.running = false;
    }
  }
}
