import type { MarketingMetricView, MetricDef, MetricUnit } from '@t3-orchestra/shared';

const DAY_MS = 86_400_000;
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** 1,284 · 12.9K · 41% · 1m 35s. `full` skips the compact form (tables, tooltips). */
export function formatValue(v: number, unit: MetricUnit, full = false): string {
  if (unit === 'percent') return `${plain.format(v)}%`;
  if (unit === 'seconds') {
    const s = Math.round(v);
    if (s < 60) return `${s}s`;
    return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`;
  }
  return !full && Math.abs(v) >= 10_000 ? compact.format(v) : plain.format(v);
}

/** Signed change: +12, −3, +2.1 pts (percent), +15s. */
export function formatDelta(d: number, unit: MetricUnit): string {
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  const abs = Math.abs(d);
  if (unit === 'percent') return `${sign}${plain.format(abs)} pts`;
  return `${sign}${formatValue(abs, unit)}`;
}

export type Tone = 'good' | 'bad' | 'neutral';

/** Whether a change is good news for this metric. */
export function deltaTone(d: number, good: MetricDef['good']): Tone {
  if (d === 0 || good === null) return 'neutral';
  return (d > 0) === (good === 'up') ? 'good' : 'bad';
}

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** "Nov 5" for a UTC YYYY-MM-DD day. */
export function dayLabel(day: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

/** The change against the metric's baseline and what it's measured against ("vs last week", "since Nov 2"). */
export function metricChange(m: MarketingMetricView): { delta: number; against: string } | null {
  if (!m.baseline) return null;
  const days = Math.round((Date.parse(m.at) - Date.parse(m.baseline.at)) / DAY_MS);
  return { delta: m.value - m.baseline.value, against: days >= 6 && days <= 8 ? 'vs last week' : `since ${shortDate(m.baseline.at)}` };
}
