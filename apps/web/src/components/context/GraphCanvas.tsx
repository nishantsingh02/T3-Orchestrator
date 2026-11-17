// The knowledge graph as an interactive picture: drag the background to pan, the wheel to zoom, a node
// to move it; click a node to select it (its links stay lit, the rest fades). Drawn in screen space,
// so dots, lines and labels keep their size at any zoom.
import type { KnowledgeGraph, KnowledgeNode, KnowledgeNodeType } from '@t3-orchestra/shared';
import { Maximize, Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { bounds, layoutGraph, type Point } from './layout';
import { typeColor, typeLabel } from './model';

interface View {
  x: number;
  y: number;
  k: number;
}

interface Props {
  graph: KnowledgeGraph;
  hiddenTypes: ReadonlySet<KnowledgeNodeType>;
  selected: string | null;
  onSelect: (key: string | null) => void;
  /** Nodes to bring forward (search hits, one file's nodes); the rest fade. */
  highlight: ReadonlySet<string> | null;
  /** Changes when a node picked elsewhere (a list, a search) should be brought into view. */
  focus: { key: string; seq: number } | null;
  className?: string;
}

const MIN_K = 0.15;
const MAX_K = 4;
const LABELED = 14; // the best-connected nodes always carry their name

const radiusOf = (degree: number) => Math.min(4.5 + Math.sqrt(degree) * 2.2, 15);

export function GraphCanvas({ graph, hiddenTypes, selected, onSelect, highlight, focus, className }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ kind: 'pan' | 'node'; key?: string; id: number; sx: number; sy: number; moved: boolean; view: View } | null>(null);

  // Layout over the whole graph, so hiding a type doesn't move the rest.
  const shape = useMemo(() => `${graph.nodes.map((n) => n.key).join('|')}#${graph.edges.map((e) => `${e.from}>${e.to}`).join('|')}`, [graph]);
  const laid = useMemo(() => layoutGraph(graph.nodes.map((n) => n.key), graph.edges), [shape]);
  const [moved, setMoved] = useState<Map<string, Point>>(new Map());
  useEffect(() => setMoved(new Map()), [laid]);
  const pos = (key: string) => moved.get(key) ?? laid.get(key);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of graph.edges) {
      d.set(e.from, (d.get(e.from) ?? 0) + 1);
      d.set(e.to, (d.get(e.to) ?? 0) + 1);
    }
    return d;
  }, [graph]);
  const labeledKeys = useMemo(
    () => new Set([...graph.nodes].sort((a, b) => (degree.get(b.key) ?? 0) - (degree.get(a.key) ?? 0)).slice(0, LABELED).map((n) => n.key)),
    [graph, degree],
  );

  const nodes = useMemo(() => graph.nodes.filter((n) => !hiddenTypes.has(n.type)), [graph, hiddenTypes]);
  const shown = useMemo(() => new Set(nodes.map((n) => n.key)), [nodes]);
  const edges = useMemo(() => graph.edges.filter((e) => shown.has(e.from) && shown.has(e.to)), [graph, shown]);
  const neighbors = useMemo(() => {
    if (!selected) return null;
    const s = new Set([selected]);
    for (const e of edges) {
      if (e.from === selected) s.add(e.to);
      if (e.to === selected) s.add(e.from);
    }
    return s;
  }, [selected, edges]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry!.contentRect.width, h: entry!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = () => {
    const b = bounds(nodes.map((n) => pos(n.key)!).filter(Boolean));
    if (!b || !size.w || !size.h) return;
    const pad = 48;
    const k = Math.min(Math.max(Math.min((size.w - pad * 2) / Math.max(b.maxX - b.minX, 1), (size.h - pad * 2) / Math.max(b.maxY - b.minY, 1)), MIN_K), 1.6);
    setView({ k, x: size.w / 2 - ((b.minX + b.maxX) / 2) * k, y: size.h / 2 - ((b.minY + b.maxY) / 2) * k });
  };
  // Fit when the graph first has room, and again when its shape changes.
  useEffect(() => {
    if (size.w && size.h) fit();
  }, [laid, size.w > 0 && size.h > 0]);

  // Bring a node picked elsewhere into the middle.
  useEffect(() => {
    if (!focus || !size.w) return;
    const p = pos(focus.key);
    if (!p) return;
    setView((v) => {
      const k = Math.max(v?.k ?? 1, 1);
      return { k, x: size.w / 2 - p.x * k, y: size.h / 2 - p.y * k };
    });
  }, [focus?.seq, size.w > 0]);

  // Wheel zoom around the pointer (a non-passive listener, so the page doesn't scroll).
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setView((v) => {
        if (!v) return v;
        const k = Math.min(Math.max(v.k * Math.exp(-e.deltaY * 0.0015), MIN_K), MAX_K);
        return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = (f: number) =>
    setView((v) => {
      if (!v) return v;
      const k = Math.min(Math.max(v.k * f, MIN_K), MAX_K);
      const cx = size.w / 2;
      const cy = size.h / 2;
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    });

  const onPointerDown = (e: ReactPointerEvent, key?: string) => {
    if (!view || e.button !== 0) return;
    e.stopPropagation();
    svg.current?.setPointerCapture(e.pointerId);
    drag.current = { kind: key ? 'node' : 'pan', key, id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, view };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const ddx = e.clientX - d.sx;
    const ddy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(ddx, ddy) < 4) return;
    d.moved = true;
    if (d.kind === 'pan') setView({ ...d.view, x: d.view.x + ddx, y: d.view.y + ddy });
    else if (d.key && view) {
      const r = svg.current!.getBoundingClientRect();
      const p = { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
      setMoved((m) => new Map(m).set(d.key!, p));
    }
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) onSelect(d.kind === 'node' ? (d.key === selected ? null : d.key!) : null);
  };

  const v = view;
  const sx = (p: Point) => p.x * (v?.k ?? 1) + (v?.x ?? 0);
  const sy = (p: Point) => p.y * (v?.k ?? 1) + (v?.y ?? 0);
  const faded = (key: string) => (neighbors ? !neighbors.has(key) : highlight ? !highlight.has(key) : false);
  const labeled = (n: KnowledgeNode) =>
    n.key === selected ||
    n.key === hover ||
    (neighbors?.has(n.key) ?? false) ||
    (highlight !== null && highlight.size <= 40 && highlight.has(n.key)) ||
    (!neighbors && !highlight && (labeledKeys.has(n.key) || (v?.k ?? 1) >= 1.5));

  const hovered = hover ? graph.nodes.find((n) => n.key === hover) : undefined;
  const hp = hovered ? pos(hovered.key) : undefined;
  const sel = selected ? graph.nodes.find((n) => n.key === selected) : undefined;

  return (
    <div ref={wrap} className={cn('relative min-h-0 overflow-hidden', className)}>
      <svg
        ref={svg}
        role="img"
        aria-label={`Knowledge graph: ${nodes.length} nodes and ${edges.length} links${sel ? `; ${sel.name} selected` : ''}`}
        className={cn('absolute inset-0 size-full touch-none select-none', drag.current?.kind === 'pan' ? 'cursor-grabbing' : 'cursor-grab')}
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
      >
        {v && (
          <>
            <g>
              {edges.map((e) => {
                const a = pos(e.from);
                const b = pos(e.to);
                if (!a || !b) return null;
                const lit = selected !== null && (e.from === selected || e.to === selected);
                const dim = !lit && (selected !== null || (highlight !== null && !(highlight.has(e.from) && highlight.has(e.to))));
                return (
                  <line
                    key={`${e.from}|${e.relation}|${e.to}`}
                    x1={sx(a)}
                    y1={sy(a)}
                    x2={sx(b)}
                    y2={sy(b)}
                    stroke={lit ? 'var(--foreground)' : 'var(--border-strong)'}
                    strokeOpacity={lit ? 0.55 : dim ? 0.25 : 0.9}
                    strokeWidth={lit ? 1.5 : 1}
                  />
                );
              })}
            </g>
            {/* The selected node's relations, on their lines. */}
            {selected &&
              edges
                .filter((e) => e.from === selected || e.to === selected)
                .map((e) => {
                  const a = pos(e.from);
                  const b = pos(e.to);
                  // A short line has no room: the side panel lists the relation.
                  if (!a || !b || Math.hypot(sx(a) - sx(b), sy(a) - sy(b)) < 110) return null;
                  return (
                    <text
                      key={`rel:${e.from}|${e.relation}|${e.to}`}
                      x={(sx(a) + sx(b)) / 2}
                      y={(sy(a) + sy(b)) / 2}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="pointer-events-none fill-muted-foreground text-[10px]"
                      style={{ paintOrder: 'stroke', stroke: 'var(--background)', strokeWidth: 3, strokeLinejoin: 'round' }}
                    >
                      {e.relation}
                    </text>
                  );
                })}
            <g>
              {nodes.map((n) => {
                const p = pos(n.key);
                if (!p) return null;
                const r = radiusOf(degree.get(n.key) ?? 0);
                const isSel = n.key === selected;
                const hit = highlight?.has(n.key) && !neighbors;
                return (
                  <g key={n.key} opacity={faded(n.key) ? 0.18 : 1}>
                    {(isSel || hit) && <circle cx={sx(p)} cy={sy(p)} r={r + 4} fill="none" stroke="var(--ring)" strokeWidth={2} />}
                    <circle
                      cx={sx(p)}
                      cy={sy(p)}
                      r={r}
                      fill={typeColor(n.type)}
                      stroke="var(--background)"
                      strokeWidth={2}
                      className="cursor-pointer"
                      onPointerDown={(e) => onPointerDown(e, n.key)}
                      onPointerEnter={() => setHover(n.key)}
                      onPointerLeave={() => setHover((h) => (h === n.key ? null : h))}
                    />
                  </g>
                );
              })}
            </g>
            <g className="pointer-events-none">
              {nodes.filter(labeled).map((n) => {
                const p = pos(n.key)!;
                const r = radiusOf(degree.get(n.key) ?? 0);
                return (
                  <text
                    key={`label:${n.key}`}
                    x={sx(p)}
                    y={sy(p) + r + (n.key === selected || highlight?.has(n.key) ? 16 : 11)}
                    textAnchor="middle"
                    opacity={faded(n.key) ? 0.35 : 1}
                    className={cn('fill-foreground text-[11px]', n.key === selected && 'font-semibold')}
                    style={{ paintOrder: 'stroke', stroke: 'var(--background)', strokeWidth: 3, strokeLinejoin: 'round' }}
                  >
                    {n.name.length > 32 ? `${n.name.slice(0, 31)}…` : n.name}
                  </text>
                );
              })}
            </g>
          </>
        )}
      </svg>

      {hovered && hp && v && !drag.current && (
        <div
          className="pointer-events-none absolute z-10 w-64 rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-lg"
          style={{
            left: Math.min(Math.max(sx(hp) + 14, 8), Math.max(size.w - 264, 8)),
            top: Math.min(Math.max(sy(hp) + 10, 8), Math.max(size.h - 120, 8)),
          }}
        >
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-2 rounded-full" style={{ background: typeColor(hovered.type) }} />
            {typeLabel(hovered.type)} · {degree.get(hovered.key) ?? 0} link{degree.get(hovered.key) === 1 ? '' : 's'}
          </p>
          <p className="mt-0.5 text-[13px] font-medium leading-snug">{hovered.name}</p>
          <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{hovered.summary}</p>
        </div>
      )}

      <div className="absolute right-2 bottom-2 flex flex-col overflow-hidden rounded-md border border-border bg-popover/95 shadow-sm">
        <Button variant="ghost" size="icon-sm" className="rounded-none" aria-label="Zoom in" onClick={() => zoomBy(1.3)}>
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-sm" className="rounded-none border-y border-border" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.3)}>
          <Minus />
        </Button>
        <Button variant="ghost" size="icon-sm" className="rounded-none" aria-label="Fit the graph" onClick={fit}>
          <Maximize />
        </Button>
      </div>
    </div>
  );
}
