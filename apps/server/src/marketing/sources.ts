// Marketing metric sources: checking what the user typed, and reading the numbers from each API.
// Everything here is pure apart from `fetch`, which callers pass in (tests use a fake one).
import { SOURCE_KIND_INFO, type MarketingSourceKind } from '@t3-orchestra/shared';

export type FetchFn = typeof fetch;

/** A source's settings after normalize(): the plain fields, the secret, and a default name. */
export interface NormalizedSource {
  config: Record<string, string>;
  secret: string | null;
  name: string;
}

export class SourceError extends Error {}

const TIMEOUT_MS = 15_000;
const DAY_S = 86_400;

/** "owner/repo" from owner/repo, a github.com URL, or an SSH remote. */
export function parseGithubRepo(input: string): string | null {
  const m = /^(?:(?:https?:\/\/|git@|ssh:\/\/git@)?(?:www\.)?github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(input.trim());
  if (!m || m[1] === '.' || m[1] === '..') return null;
  return `${m[1]}/${m[2]}`;
}

function bareHost(input: string): string {
  return input.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function baseUrl(input: string | undefined, fallback: string): string {
  const v = (input ?? '').trim().replace(/\/+$/, '');
  if (!v) return fallback;
  const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    new URL(url);
  } catch {
    throw new SourceError(`"${input}" is not a valid host.`);
  }
  return url;
}

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const DOCKER_PART = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Checks and tidies a source's fields. `secret` undefined keeps `previousSecret` (edits); null or ''
 * removes it. Throws SourceError with a message for the user.
 */
export function normalizeSource(
  kind: MarketingSourceKind,
  raw: Record<string, string>,
  secret: string | null | undefined,
  previousSecret: string | null = null,
): NormalizedSource {
  const info = SOURCE_KIND_INFO[kind];
  const secretField = info.fields.find((f) => f.secret);
  const config: Record<string, string> = {};
  for (const f of info.fields) {
    if (f.secret) continue;
    const v = (raw[f.key] ?? '').trim();
    if (!v && !f.optional) throw new SourceError(`${f.label} is required.`);
    if (v) config[f.key] = v;
  }
  const nextSecret = secret === undefined ? previousSecret : secret?.trim() || null;
  if (secretField && !secretField.optional && !nextSecret) throw new SourceError(`${secretField.label} is required.`);

  let name: string;
  switch (kind) {
    case 'github': {
      const repo = parseGithubRepo(config.repo!);
      if (!repo) throw new SourceError('Repository should look like owner/repo or a github.com link.');
      config.repo = repo;
      name = repo;
      break;
    }
    case 'plausible':
      config.site = bareHost(config.site!);
      if (config.host) config.host = baseUrl(config.host, '');
      name = config.site;
      break;
    case 'posthog':
      if (!/^\d+$/.test(config.projectId!)) throw new SourceError('Project ID should be a number (it is in your PostHog project URL).');
      if (config.host) config.host = baseUrl(config.host, '');
      name = `PostHog project ${config.projectId}`;
      break;
    case 'npm':
      config.package = config.package!.toLowerCase();
      if (!NPM_NAME.test(config.package)) throw new SourceError(`"${config.package}" is not a valid npm package name.`);
      name = config.package;
      break;
    case 'pypi':
      if (!PYPI_NAME.test(config.package!)) throw new SourceError(`"${config.package}" is not a valid PyPI package name.`);
      name = config.package!;
      break;
    case 'docker': {
      const image = config.image!.toLowerCase().replace(/^(?:https?:\/\/)?hub\.docker\.com\/(?:r\/|_\/)?/, '').replace(/\/+$/, '');
      const parts = image.includes('/') ? image.split('/') : ['library', image];
      if (parts.length !== 2 || !parts.every((p) => DOCKER_PART.test(p))) throw new SourceError('Image should look like namespace/repository.');
      config.image = parts.join('/');
      name = config.image;
      break;
    }
    case 'hackernews':
      name = `HN: ${config.query}`;
      break;
    case 'json':
      if (!/^https?:\/\//i.test(config.url!)) throw new SourceError('URL should start with http:// or https://.');
      try {
        new URL(config.url!);
      } catch {
        throw new SourceError(`"${config.url}" is not a valid URL.`);
      }
      if (nextSecret && !config.header) config.header = 'Authorization';
      name = config.label!;
      break;
    case 'manual':
      name = config.label!;
      break;
  }
  return { config, secret: secretField ? nextSecret : null, name };
}

/** A failed API call, worded for the source card. */
async function httpError(res: Response): Promise<SourceError> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { message?: unknown; error?: unknown; detail?: unknown };
      const m = body.message ?? body.error ?? body.detail;
      detail = typeof m === 'string' ? m : '';
    } catch {
      detail = text.trim().slice(0, 160);
    }
  } catch {
    // no body
  }
  const what =
    res.status === 401 || res.status === 403
      ? 'The key or token was refused'
      : res.status === 404
        ? 'Not found: check the name'
        : res.status === 429
          ? 'Rate limited: it will try again later'
          : 'The request failed';
  return new SourceError(`${what} (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`);
}

async function getJson(fetchFn: FetchFn, url: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      ...init,
      headers: { Accept: 'application/json', 'User-Agent': 'T3 Orchestra', ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new SourceError(timeout ? `No answer from ${new URL(url).host} within ${TIMEOUT_MS / 1000}s.` : `Could not reach ${new URL(url).host}.`);
  }
  if (!res.ok) throw await httpError(res);
  try {
    return await res.json();
  } catch {
    throw new SourceError(`${new URL(url).host} did not answer with JSON.`);
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});

/** Follows a dot path (`data.items.0.count`) into parsed JSON. */
export function atPath(value: unknown, path: string): unknown {
  let cur = value;
  for (const part of path.split('.').filter(Boolean)) {
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (typeof cur === 'object' && cur !== null) cur = (cur as Obj)[part];
    else return undefined;
  }
  return cur;
}

/** HogQL string literal. */
function hogqlString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function github(fetchFn: FetchFn, config: Record<string, string>, token: string | null): Promise<Record<string, number>> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const base = `https://api.github.com/repos/${config.repo}`;
  const repo = obj(await getJson(fetchFn, base, { headers }));
  const out: Record<string, number> = {};
  const put = (key: string, v: unknown) => {
    const n = num(v);
    if (n !== null) out[key] = n;
  };
  put('stars', repo.stargazers_count);
  put('forks', repo.forks_count);
  put('watchers', repo.subscribers_count);
  put('open_issues', repo.open_issues_count);

  const releases = await getJson(fetchFn, `${base}/releases?per_page=100`, { headers }).catch(() => null);
  // Only when releases ship files: a repo that releases tags alone has nothing to download.
  const assets = Array.isArray(releases) ? releases.flatMap((r) => (obj(r).assets as unknown[] | undefined) ?? []) : [];
  if (assets.length > 0) out.release_downloads = assets.reduce<number>((sum, a) => sum + (num(obj(a).download_count) ?? 0), 0);
  // Traffic needs push access; without it these are 403s, which just means no traffic numbers.
  if (token) {
    const [views, clones] = await Promise.all([
      getJson(fetchFn, `${base}/traffic/views`, { headers }).catch(() => null),
      getJson(fetchFn, `${base}/traffic/clones`, { headers }).catch(() => null),
    ]);
    if (views) {
      put('views_14d', obj(views).count);
      put('visitors_14d', obj(views).uniques);
    }
    if (clones) put('clones_14d', obj(clones).count);
  }
  return out;
}

async function plausible(fetchFn: FetchFn, config: Record<string, string>, key: string): Promise<Record<string, number>> {
  const host = baseUrl(config.host, 'https://plausible.io');
  const metrics = ['visitors', 'pageviews', 'bounce_rate', 'visit_duration'];
  const body = await getJson(fetchFn, `${host}/api/v2/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ site_id: config.site, metrics, date_range: '30d' }),
  });
  const row = (obj(body).results as unknown[] | undefined)?.[0];
  const values = obj(row).metrics as unknown[] | undefined;
  if (!Array.isArray(values)) throw new SourceError('Plausible answered without numbers.');
  const keys = ['visitors_30d', 'pageviews_30d', 'bounce_rate', 'visit_duration'];
  const out: Record<string, number> = {};
  keys.forEach((k, i) => {
    const n = num(values[i]);
    if (n !== null) out[k] = n;
  });
  return out;
}

async function posthog(fetchFn: FetchFn, config: Record<string, string>, key: string): Promise<Record<string, number>> {
  const host = baseUrl(config.host, 'https://us.posthog.com');
  const query = (sql: string) =>
    getJson(fetchFn, `${host}/api/projects/${config.projectId}/query/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql }, name: 'T3 Orchestra marketing metrics' }),
    }).then((b) => {
      const row = (obj(b).results as unknown[] | undefined)?.[0];
      if (!Array.isArray(row)) throw new SourceError('PostHog answered without numbers.');
      return row;
    });
  const since = 'timestamp > now() - INTERVAL 30 DAY';
  const [pageviews, visitors] = await query(`SELECT count(), count(DISTINCT person_id) FROM events WHERE event = '$pageview' AND ${since}`);
  const out: Record<string, number> = {};
  if (num(pageviews) !== null) out.pageviews_30d = num(pageviews)!;
  if (num(visitors) !== null) out.visitors_30d = num(visitors)!;
  if (config.signupEvent) {
    const [signups] = await query(`SELECT count() FROM events WHERE event = ${hogqlString(config.signupEvent)} AND ${since}`);
    if (num(signups) !== null) out.signups_30d = num(signups)!;
  }
  return out;
}

async function npm(fetchFn: FetchFn, config: Record<string, string>): Promise<Record<string, number>> {
  const at = (period: string) => getJson(fetchFn, `https://api.npmjs.org/downloads/point/${period}/${config.package}`).then((b) => num(obj(b).downloads));
  const [week, month] = await Promise.all([at('last-week'), at('last-month')]);
  const out: Record<string, number> = {};
  if (week !== null) out.downloads_week = week;
  if (month !== null) out.downloads_month = month;
  return out;
}

async function pypi(fetchFn: FetchFn, config: Record<string, string>): Promise<Record<string, number>> {
  const body = await getJson(fetchFn, `https://pypistats.org/api/packages/${encodeURIComponent(config.package!.toLowerCase())}/recent`);
  const data = obj(obj(body).data);
  const out: Record<string, number> = {};
  for (const [from, to] of [
    ['last_day', 'downloads_day'],
    ['last_week', 'downloads_week'],
    ['last_month', 'downloads_month'],
  ] as const) {
    const n = num(data[from]);
    if (n !== null) out[to] = n;
  }
  return out;
}

async function docker(fetchFn: FetchFn, config: Record<string, string>): Promise<Record<string, number>> {
  const body = obj(await getJson(fetchFn, `https://hub.docker.com/v2/repositories/${config.image}/`));
  const out: Record<string, number> = {};
  if (num(body.pull_count) !== null) out.pulls = num(body.pull_count)!;
  if (num(body.star_count) !== null) out.stars = num(body.star_count)!;
  return out;
}

async function hackernews(fetchFn: FetchFn, config: Record<string, string>, nowMs: number): Promise<Record<string, number>> {
  const since = Math.floor(nowMs / 1000) - 30 * DAY_S;
  const params = new URLSearchParams({ query: config.query!, tags: 'story', numericFilters: `created_at_i>${since}`, hitsPerPage: '100' });
  const body = obj(await getJson(fetchFn, `https://hn.algolia.com/api/v1/search?${params}`));
  const hits = (body.hits as unknown[] | undefined) ?? [];
  let points = 0;
  let comments = 0;
  for (const h of hits) {
    points += num(obj(h).points) ?? 0;
    comments += num(obj(h).num_comments) ?? 0;
  }
  return { stories_30d: num(body.nbHits) ?? hits.length, points_30d: points, comments_30d: comments };
}

async function customJson(fetchFn: FetchFn, config: Record<string, string>, headerValue: string | null): Promise<Record<string, number>> {
  const headers: Record<string, string> = {};
  if (headerValue) headers[config.header || 'Authorization'] = headerValue;
  const body = await getJson(fetchFn, config.url!, { headers });
  const v = num(atPath(body, config.path!));
  if (v === null) throw new SourceError(`No number at "${config.path}" in the response.`);
  return { value: v };
}

/** Reads the source's current numbers, keyed by metric. Throws SourceError. */
export async function fetchMetrics(
  fetchFn: FetchFn,
  kind: MarketingSourceKind,
  config: Record<string, string>,
  secret: string | null,
  nowMs = Date.now(),
): Promise<Record<string, number>> {
  switch (kind) {
    case 'github':
      return github(fetchFn, config, secret);
    case 'plausible':
      return plausible(fetchFn, config, secret ?? '');
    case 'posthog':
      return posthog(fetchFn, config, secret ?? '');
    case 'npm':
      return npm(fetchFn, config);
    case 'pypi':
      return pypi(fetchFn, config);
    case 'docker':
      return docker(fetchFn, config);
    case 'hackernews':
      return hackernews(fetchFn, config, nowMs);
    case 'json':
      return customJson(fetchFn, config, secret);
    case 'manual':
      return {};
  }
}
