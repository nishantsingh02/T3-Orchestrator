// Marketing view: the sources ("connections") its metrics come from and what each one measures.
// The server fetches the numbers; the web UI renders the connect form from SOURCE_KIND_INFO.

export const MARKETING_SOURCE_KINDS = ['github', 'plausible', 'posthog', 'npm', 'pypi', 'docker', 'hackernews', 'json', 'manual'] as const;
export type MarketingSourceKind = (typeof MARKETING_SOURCE_KINDS)[number];

/** `new`: not fetched yet (or a manual metric with no value logged). */
export type MarketingSourceStatus = 'new' | 'ok' | 'error';

export type MetricUnit = 'count' | 'percent' | 'seconds';

export interface MetricDef {
  key: string;
  label: string;
  unit: MetricUnit;
  /** Which direction is good news; null when neither is (open issues). */
  good: 'up' | 'down' | null;
}

export interface SourceField {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  /** Kept on the server only (API keys, tokens); never sent back to the browser. */
  secret?: boolean;
  optional?: boolean;
}

export interface SourceKindInfo {
  label: string;
  blurb: string;
  fields: SourceField[];
  /** What it can measure. `json` and `manual` measure one value the user names. */
  metrics: MetricDef[];
  /** False for manual metrics: values are typed in, never fetched. */
  fetched: boolean;
}

const count = (key: string, label: string, good: MetricDef['good'] = 'up'): MetricDef => ({ key, label, unit: 'count', good });

export const SOURCE_KIND_INFO: Record<MarketingSourceKind, SourceKindInfo> = {
  github: {
    label: 'GitHub',
    blurb: 'Stars, forks, watchers and release downloads. With a token: page views and clones.',
    fetched: true,
    fields: [
      { key: 'repo', label: 'Repository', placeholder: 'owner/repo or a github.com link' },
      {
        key: 'token',
        label: 'Token',
        secret: true,
        optional: true,
        placeholder: 'github_pat_…',
        help: 'Optional. Private repos need one, and traffic (views, clones) needs a token with push access to the repo.',
      },
    ],
    metrics: [
      count('stars', 'Stars'),
      count('forks', 'Forks'),
      count('watchers', 'Watchers'),
      count('open_issues', 'Open issues and PRs', null),
      count('release_downloads', 'Release downloads'),
      count('views_14d', 'Repo views (14d)'),
      count('visitors_14d', 'Repo visitors (14d)'),
      count('clones_14d', 'Clones (14d)'),
    ],
  },
  plausible: {
    label: 'Plausible',
    blurb: 'Website visitors, page views, bounce rate and visit time over the last 30 days.',
    fetched: true,
    fields: [
      { key: 'site', label: 'Site', placeholder: 'example.com', help: 'The domain as it is set up in Plausible.' },
      { key: 'apiKey', label: 'Stats API key', secret: true, help: 'Plausible → Account settings → API keys.' },
      { key: 'host', label: 'Host', optional: true, placeholder: 'https://plausible.io', help: 'Only for a self-hosted Plausible.' },
    ],
    metrics: [
      count('visitors_30d', 'Visitors (30d)'),
      count('pageviews_30d', 'Page views (30d)'),
      { key: 'bounce_rate', label: 'Bounce rate (30d)', unit: 'percent', good: 'down' },
      { key: 'visit_duration', label: 'Visit duration (30d)', unit: 'seconds', good: 'up' },
    ],
  },
  posthog: {
    label: 'PostHog',
    blurb: 'Page views and unique visitors over the last 30 days, and an event you count as a sign-up.',
    fetched: true,
    fields: [
      { key: 'projectId', label: 'Project ID', placeholder: '12345', help: 'The number in your PostHog project URL.' },
      { key: 'apiKey', label: 'Personal API key', secret: true, placeholder: 'phx_…', help: 'Needs the Query Read scope.' },
      { key: 'signupEvent', label: 'Sign-up event', optional: true, placeholder: 'user_signed_up', help: 'Optional. Counted over the last 30 days.' },
      { key: 'host', label: 'Host', optional: true, placeholder: 'https://us.posthog.com', help: 'https://eu.posthog.com for EU Cloud, or your own instance.' },
    ],
    metrics: [count('pageviews_30d', 'Page views (30d)'), count('visitors_30d', 'Visitors (30d)'), count('signups_30d', 'Sign-ups (30d)')],
  },
  npm: {
    label: 'npm',
    blurb: 'Weekly and monthly downloads of a published package.',
    fetched: true,
    fields: [{ key: 'package', label: 'Package', placeholder: 'my-package or @scope/name' }],
    metrics: [count('downloads_week', 'Downloads (week)'), count('downloads_month', 'Downloads (month)')],
  },
  pypi: {
    label: 'PyPI',
    blurb: 'Daily, weekly and monthly downloads of a Python package (from pypistats.org).',
    fetched: true,
    fields: [{ key: 'package', label: 'Package', placeholder: 'my-package' }],
    metrics: [count('downloads_day', 'Downloads (day)'), count('downloads_week', 'Downloads (week)'), count('downloads_month', 'Downloads (month)')],
  },
  docker: {
    label: 'Docker Hub',
    blurb: 'Total pulls and stars of a Docker Hub image.',
    fetched: true,
    fields: [{ key: 'image', label: 'Image', placeholder: 'namespace/repository' }],
    metrics: [count('pulls', 'Pulls'), count('stars', 'Stars')],
  },
  hackernews: {
    label: 'Hacker News',
    blurb: 'Stories that mention you in the last 30 days, with their points and comments.',
    fetched: true,
    fields: [
      {
        key: 'query',
        label: 'Search for',
        placeholder: 'example.com or github.com/owner/repo',
        help: 'Matched against story titles and links. A domain or repo link finds you better than a name.',
      },
    ],
    metrics: [count('stories_30d', 'HN stories (30d)'), count('points_30d', 'HN points (30d)'), count('comments_30d', 'HN comments (30d)')],
  },
  json: {
    label: 'Custom JSON',
    blurb: 'Any URL that returns JSON: your own stats endpoint, a no-code tool, another API.',
    fetched: true,
    fields: [
      { key: 'label', label: 'Metric name', placeholder: 'Paying customers' },
      { key: 'url', label: 'URL', placeholder: 'https://api.example.com/stats' },
      { key: 'path', label: 'Value at', placeholder: 'data.total', help: 'Dot path to the number in the response, like data.total or items.0.count.' },
      { key: 'header', label: 'Header name', optional: true, placeholder: 'Authorization' },
      { key: 'headerValue', label: 'Header value', optional: true, secret: true, placeholder: 'Bearer …' },
    ],
    metrics: [count('value', 'Value')],
  },
  manual: {
    label: 'Manual',
    blurb: 'A number you log yourself: followers, newsletter subscribers, waitlist sign-ups.',
    fetched: false,
    fields: [{ key: 'label', label: 'Metric name', placeholder: 'Newsletter subscribers' }],
    metrics: [count('value', 'Value')],
  },
};

/** The metrics a source can report, named for this source (json and manual take the user's name). */
export function metricDefs(kind: MarketingSourceKind, config: Record<string, string>): MetricDef[] {
  const defs = SOURCE_KIND_INFO[kind].metrics;
  if (kind === 'json' || kind === 'manual') return defs.map((d) => ({ ...d, label: config.label?.trim() || d.label }));
  if (kind === 'posthog' && !config.signupEvent?.trim()) return defs.filter((d) => d.key !== 'signups_30d');
  return defs;
}

/** One day of a metric: its last value that day (UTC). */
export interface MetricPoint {
  day: string;
  value: number;
}

export interface MarketingMetricView extends MetricDef {
  value: number;
  at: string;
  /** About a week earlier, or the oldest value when the history is shorter; null when there is nothing to compare. */
  baseline: { value: number; at: string } | null;
  /** The last 90 days, oldest first. */
  points: MetricPoint[];
}

export interface MarketingSourceView {
  id: string;
  boardId: string;
  kind: MarketingSourceKind;
  name: string;
  /** Without the secret field. */
  config: Record<string, string>;
  hasSecret: boolean;
  status: MarketingSourceStatus;
  error: string | null;
  lastFetchedAt: string | null;
  createdAt: string;
  /** Metrics with at least one value, in the kind's order. */
  metrics: MarketingMetricView[];
}

/** A source found in the project (git remote, package.json) that isn't connected yet. */
export interface SourceSuggestion {
  kind: MarketingSourceKind;
  name: string;
  config: Record<string, string>;
  /** Where it was found. */
  reason: string;
}

/** GET /api/boards/:id/marketing */
export interface BoardMarketingView {
  sources: MarketingSourceView[];
  suggestions: SourceSuggestion[];
}
