import type { OverviewDay } from '@t3-orchestra/shared';
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

// Grouped columns: Done (the series that matters, in the Done stage colour) beside Added (grey context).
const SERIES = [
  { key: 'done', label: 'Done', fill: 'fill-stage-done', swatch: 'bg-stage-done' },
  { key: 'added', label: 'Added', fill: 'fill-stage-backlog/70', swatch: 'bg-stage-backlog/70' },
] as const;

const PLOT_H = 140;
const TOP = 8;
const AXIS_H = 20;
const LEFT = 26;
const GAP = 2;

/** "Nov 5" from a local YYYY-MM-DD day. */
export function dayLabel(day: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, opts);
}

/** Smallest clean step that keeps the axis at four ticks or fewer. */
function niceStep(max: number): number {
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500]) if (max / s <= 4) return s;
  return Math.ceil(max / 4);
}

/** Column with a 4px rounded top and a square base. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
}

/** The element's width, kept current with a ResizeObserver. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function ChartLegend() {
  return (
    <div className="flex items-center gap-3 text-[11.5px] text-muted-foreground">
      {SERIES.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className={cn('size-2 rounded-[2px]', s.swatch)} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function DailyTable({ days }: { days: OverviewDay[] }) {
  return (
    <div className="max-h-[188px] overflow-y-auto scrollbar-thin">
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 bg-card text-left text-[11px] text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">Day</th>
            <th className="py-1 text-right font-medium">Done</th>
            <th className="py-1 text-right font-medium">Added</th>
          </tr>
        </thead>
        <tbody className="tabular">
          {[...days].reverse().map((d) => (
            <tr key={d.day} className="border-t border-border">
              <td className="py-1">{dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
              <td className="py-1 text-right">{d.done}</td>
              <td className="py-1 text-right">{d.added}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DailyChart({ days }: { days: OverviewDay[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const max = Math.max(1, ...days.map((d) => Math.max(d.done, d.added)));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const plotW = Math.max(0, width - LEFT);
  const band = days.length ? plotW / days.length : 0;
  const barW = Math.max(3, Math.min(14, (band * 0.62 - GAP) / 2));
  const y = (v: number) => TOP + PLOT_H - (v / top) * PLOT_H;
  const labelEvery = Math.max(1, Math.ceil((days.length * 46) / Math.max(plotW, 1)));
  const today = days.length - 1;
  const hovered = hover === null ? null : days[hover];

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={TOP + PLOT_H + AXIS_H} role="img" aria-label="Tasks done and added per day">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={LEFT} x2={width} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={LEFT - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular">
                {t}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const x0 = LEFT + i * band;
            const groupX = x0 + (band - (barW * 2 + GAP)) / 2;
            return (
              <g key={d.day}>
                {hover === i && <rect x={x0 + 1} y={TOP} width={band - 2} height={PLOT_H} rx={4} className="fill-muted" />}
                {SERIES.map((s, si) => {
                  const v = d[s.key];
                  if (v <= 0) return null;
                  const h = Math.max(1, (v / top) * PLOT_H);
                  return <path key={s.key} d={columnPath(groupX + si * (barW + GAP), TOP + PLOT_H - h, barW, h)} className={s.fill} />;
                })}
                {(i % labelEvery === (today % labelEvery) || i === today) && (
                  <text
                    x={x0 + band / 2}
                    y={TOP + PLOT_H + 14}
                    textAnchor="middle"
                    className={cn('text-[10px]', i === today ? 'fill-foreground' : 'fill-muted-foreground')}
                  >
                    {i === today ? 'Today' : dayLabel(d.day)}
                  </text>
                )}
                {/* Hit target: the whole day band, keyboard-focusable. */}
                <rect
                  x={x0}
                  y={TOP}
                  width={band}
                  height={PLOT_H}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${dayLabel(d.day)}: ${d.done} done, ${d.added} added`}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className="outline-none"
                />
              </g>
            );
          })}
        </svg>
      )}
      {hovered && hover !== null && (
        // Beside the hovered day, never over its columns: to the right, or to the left near the edge.
        <div
          className={cn(
            'pointer-events-none absolute top-0 z-10 min-w-28 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
            LEFT + (hover + 1) * band + 130 > width && '-translate-x-full',
          )}
          style={{
            left: LEFT + (hover + 1) * band + 130 > width ? LEFT + hover * band - 4 : LEFT + (hover + 1) * band + 4,
          }}
        >
          <div className="mb-1 text-[11px] text-muted-foreground">
            {dayLabel(hovered.day, { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
          {SERIES.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className={cn('h-0.5 w-2.5 rounded-full', s.swatch)} />
              <span className="font-semibold tabular">{hovered[s.key]}</span>
              <span className="text-muted-foreground">{s.label.toLowerCase()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
