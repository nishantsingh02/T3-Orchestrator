// Metric tiles (value, change, 30-day sparkline) and the history dialog (90-day line chart + table).
import type { MarketingMetricView, MetricPoint, MetricUnit } from '@t3-orchestra/shared';
import { Table2, ChartLine } from 'lucide-react';
import { useState } from 'react';
import { useWidth } from '@/components/overview/DailyChart';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { dayLabel, deltaTone, formatDelta, formatValue, metricChange, type Tone } from './format';

const TONE: Record<Tone, string> = { good: 'text-success', bad: 'text-destructive', neutral: 'text-muted-foreground' };

/** Points spread over the width; the y range is the points' own (a sparkline shows shape, not size). */
function layout(points: MetricPoint[], w: number, h: number, pad: { x: number; top: number; bottom: number }, domain?: [number, number]) {
  const values = points.map((p) => p.value);
  const [lo, hi] = domain ?? [Math.min(...values), Math.max(...values)];
  const span = hi - lo || 1;
  const x = (i: number) => pad.x + (points.length < 2 ? (w - 2 * pad.x) / 2 : (i / (points.length - 1)) * (w - 2 * pad.x));
  const y = (v: number) => (hi === lo && !domain ? pad.top + (h - pad.top - pad.bottom) / 2 : pad.top + (1 - (v - lo) / span) * (h - pad.top - pad.bottom));
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  return { x, y, line };
}

/** Index of the point nearest the pointer. */
function nearest(e: React.PointerEvent<SVGElement>, n: number, w: number, padX: number): number {
  const rect = e.currentTarget.getBoundingClientRect();
  const t = (e.clientX - rect.left - padX) / Math.max(1, w - 2 * padX);
  return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
}

const SPARK_H = 30;

function Sparkline({ points, hover, onHover }: { points: MetricPoint[]; hover: number | null; onHover: (i: number | null) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  if (points.length < 2) return <div ref={ref} className="h-[30px]" aria-hidden />;
  const pad = { x: 3, top: 4, bottom: 4 };
  const { x, y, line } = layout(points, width, SPARK_H, pad);
  const last = points.length - 1;
  const at = hover ?? last;
  return (
    <div ref={ref} className="h-[30px]" aria-hidden>
      {width > 0 && (
        <svg
          width={width}
          height={SPARK_H}
          onPointerMove={(e) => onHover(nearest(e, points.length, width, pad.x))}
          onPointerLeave={() => onHover(null)}
          className="overflow-visible"
        >
          <path d={line} fill="none" className="stroke-muted-foreground/45" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={SPARK_H} className="stroke-border-strong" strokeWidth={1} />}
          <circle cx={x(at)} cy={y(points[at]!.value)} r={3} className="fill-primary stroke-card" strokeWidth={2} />
        </svg>
      )}
    </div>
  );
}

/** One metric: label, value, change against about a week ago, and its last 30 days. Opens the history. */
export function MetricTile({ metric, onOpen }: { metric: MarketingMetricView; onOpen: () => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = metric.points.slice(-30);
  const hovered = hover !== null ? points[hover] : undefined;
  const change = metricChange(metric);
  const value = formatValue(hovered?.value ?? metric.value, metric.unit);
  const label = change ? `${formatDelta(change.delta, metric.unit)} ${change.against}` : `Updated ${relativeTime(metric.at)}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${metric.label}: ${formatValue(metric.value, metric.unit, true)}, ${label}. Show history`}
      className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-background/40 px-3 pt-2.5 pb-2 text-left transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="truncate text-xs text-muted-foreground">{metric.label}</span>
      <span className="text-xl leading-7 font-semibold tracking-tight">{value}</span>
      <span className="h-4 truncate text-[11.5px] leading-4">
        {hovered ? (
          <span className="text-muted-foreground">{dayLabel(hovered.day, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        ) : change ? (
          <>
            <span className={cn('font-medium', TONE[deltaTone(change.delta, metric.good)])}>{formatDelta(change.delta, metric.unit)}</span>{' '}
            <span className="text-muted-foreground">{change.against}</span>
          </>
        ) : (
          <span className="text-muted-foreground">{label}</span>
        )}
      </span>
      <Sparkline points={points} hover={hover} onHover={setHover} />
    </button>
  );
}

/** Clean axis steps (1, 2, 2.5, 5 × 10^k) over the data's range. */
function niceDomain(values: number[], ticks = 4): { lo: number; hi: number; step: number } {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    lo = lo === 0 ? 0 : lo - Math.abs(lo) * 0.1;
    hi = hi === 0 ? 1 : hi + Math.abs(hi) * 0.1;
  }
  const raw = (hi - lo) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((s) => s * mag >= raw) ?? 10) * mag;
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

const CHART_H = 190;
const AXIS_W = 48;
const AXIS_H = 22;

function LineChart({ points, unit, label }: { points: MetricPoint[]; unit: MetricUnit; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { lo, hi, step } = niceDomain(points.map((p) => p.value));
  const plotW = Math.max(0, width - AXIS_W);
  const pad = { x: 6, top: 8, bottom: AXIS_H };
  const { x, y, line } = layout(points, plotW, CHART_H, pad, [lo, hi]);
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
  const last = points.length - 1;
  const labelAt = new Set([0, Math.round(last / 2), last]);
  const h = hover !== null ? points[hover] : undefined;
  const area = `${line}L${x(last).toFixed(1)},${CHART_H - AXIS_H}L${x(0).toFixed(1)},${CHART_H - AXIS_H}Z`;

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={CHART_H} role="img" aria-label={`${label}, last ${points.length} days`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={AXIS_W} x2={width} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={AXIS_W - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular">
                {formatValue(t, unit)}
              </text>
            </g>
          ))}
          <g transform={`translate(${AXIS_W},0)`}>
            {points.length > 1 && <path d={area} className="fill-primary/8" />}
            <path d={line} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {points.map((p, i) =>
              labelAt.has(i) ? (
                <text key={p.day} x={x(i)} y={CHART_H - 6} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} className="fill-muted-foreground text-[10px]">
                  {dayLabel(p.day)}
                </text>
              ) : null,
            )}
            {h && (
              <>
                <line x1={x(hover!)} x2={x(hover!)} y1={pad.top} y2={CHART_H - AXIS_H} className="stroke-border-strong" strokeWidth={1} />
                <circle cx={x(hover!)} cy={y(h.value)} r={4} className="fill-primary stroke-popover" strokeWidth={2} />
              </>
            )}
            <rect
              x={0}
              y={0}
              width={plotW}
              height={CHART_H - AXIS_H}
              fill="transparent"
              onPointerMove={(e) => setHover(nearest(e, points.length, plotW, pad.x))}
            />
          </g>
        </svg>
      )}
      {h && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-2 py-1 text-xs whitespace-nowrap shadow-md"
          style={{ left: Math.min(Math.max(AXIS_W + x(hover!), 60), width - 60) }}
        >
          <span className="text-muted-foreground">{dayLabel(h.day, { weekday: 'short', month: 'short', day: 'numeric' })}</span>{' '}
          <span className="font-medium">{formatValue(h.value, unit, true)}</span>
        </div>
      )}
    </div>
  );
}

function HistoryTable({ points, unit }: { points: MetricPoint[]; unit: MetricUnit }) {
  return (
    <div className="max-h-64 overflow-y-auto scrollbar-thin">
      <table className="w-full text-[12.5px]">
        <thead className="sticky top-0 bg-popover text-left text-[11px] text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">Day</th>
            <th className="py-1 text-right font-medium">Value</th>
            <th className="py-1 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody className="tabular">
          {points
            .map((p, i) => ({ p, d: i > 0 ? p.value - points[i - 1]!.value : null }))
            .reverse()
            .map(({ p, d }) => (
              <tr key={p.day} className="border-t border-border">
                <td className="py-1">{dayLabel(p.day, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                <td className="py-1 text-right">{formatValue(p.value, unit, true)}</td>
                <td className="py-1 text-right text-muted-foreground">{d === null || d === 0 ? '' : formatDelta(d, unit)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

/** A metric's last 90 days, as a chart or a table. */
export function MetricDialog({ source, metric, onClose }: { source: string; metric: MarketingMetricView | null; onClose: () => void }) {
  const [asTable, setAsTable] = useState(false);
  const change = metric ? metricChange(metric) : null;
  return (
    <Dialog open={metric !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        {metric && (
          <>
            <DialogHeader>
              <DialogTitle>{metric.label}</DialogTitle>
              <DialogDescription>
                {source} · updated {relativeTime(metric.at)}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex items-baseline gap-2.5">
                <span className="text-3xl font-semibold tracking-tight">{formatValue(metric.value, metric.unit, true)}</span>
                {change && (
                  <span className="text-[13px]">
                    <span className={cn('font-medium', TONE[deltaTone(change.delta, metric.good)])}>{formatDelta(change.delta, metric.unit)}</span>{' '}
                    <span className="text-muted-foreground">{change.against}</span>
                  </span>
                )}
              </div>
              {metric.points.length > 1 && (
                <Button variant="ghost" size="sm" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
                  {asTable ? <ChartLine /> : <Table2 />}
                  {asTable ? 'Chart' : 'Table'}
                </Button>
              )}
            </div>
            {metric.points.length < 2 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[13px] text-muted-foreground">
                One day of history so far. The chart fills in as T3 Orchestra reads this source again (about every six hours).
              </p>
            ) : asTable ? (
              <HistoryTable points={metric.points} unit={metric.unit} />
            ) : (
              <LineChart points={metric.points} unit={metric.unit} label={metric.label} />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
