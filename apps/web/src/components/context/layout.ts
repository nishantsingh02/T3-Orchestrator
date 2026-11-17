// Force-directed layout for the knowledge graph (Fruchterman-Reingold with a pull to the middle).
// Runs once per graph, synchronously; start positions come from each key's hash, so the same graph
// lays out the same way every time.

export interface Point {
  x: number;
  y: number;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Positions around (0, 0). Big graphs get fewer rounds, so it stays well under a second. */
export function layoutGraph(keys: readonly string[], edges: ReadonlyArray<{ from: string; to: string }>): Map<string, Point> {
  const n = keys.length;
  const out = new Map<string, Point>();
  if (n === 0) return out;
  const index = new Map(keys.map((k, i) => [k, i]));
  const links = edges.flatMap((e) => {
    const a = index.get(e.from);
    const b = index.get(e.to);
    return a === undefined || b === undefined || a === b ? [] : [[a, b] as const];
  });

  const k = 42; // ideal distance between linked nodes
  const radius = Math.sqrt(n) * k * 0.9;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  keys.forEach((key, i) => {
    const h = hash(key);
    const angle = ((h % 3600) / 3600) * Math.PI * 2;
    const r = radius * Math.sqrt(((h >>> 12) % 1000) / 1000);
    xs[i] = Math.cos(angle) * r;
    ys[i] = Math.sin(angle) * r;
  });

  const rounds = n <= 150 ? 300 : n <= 400 ? 180 : 90;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  let temperature = radius / 4;
  const cool = temperature / (rounds + 1);
  for (let round = 0; round < rounds; round++) {
    dx.fill(0);
    dy.fill(0);
    // Every pair pushes apart.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let vx = xs[i]! - xs[j]!;
        let vy = ys[i]! - ys[j]!;
        let d2 = vx * vx + vy * vy;
        if (d2 < 0.01) {
          vx = 0.1 * ((i % 7) - 3);
          vy = 0.1 * ((j % 5) - 2);
          d2 = 0.01;
        }
        // Far apart, the push fades fast, so separate clusters settle near each other.
        const far = (k * 5) ** 2;
        const f = ((k * k) / d2) * (d2 > far ? far / d2 : 1);
        dx[i]! += vx * f;
        dy[i]! += vy * f;
        dx[j]! -= vx * f;
        dy[j]! -= vy * f;
      }
    }
    // Links pull together.
    for (const [a, b] of links) {
      const vx = xs[a]! - xs[b]!;
      const vy = ys[a]! - ys[b]!;
      const d = Math.sqrt(vx * vx + vy * vy) || 0.01;
      const f = d / k;
      dx[a]! -= vx * f;
      dy[a]! -= vy * f;
      dx[b]! += vx * f;
      dy[b]! += vy * f;
    }
    // Loose nodes and separate clusters drift back to the middle.
    for (let i = 0; i < n; i++) {
      dx[i]! -= xs[i]! * 0.08;
      dy[i]! -= ys[i]! * 0.08;
      const len = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!) || 1;
      const step = Math.min(len, temperature);
      xs[i]! += (dx[i]! / len) * step;
      ys[i]! += (dy[i]! / len) * step;
    }
    temperature = Math.max(temperature - cool, 0.5);
  }
  keys.forEach((key, i) => out.set(key, { x: xs[i]!, y: ys[i]! }));
  return out;
}

export function bounds(points: Iterable<Point>): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const p of points) {
    if (!b) b = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
    else {
      b.minX = Math.min(b.minX, p.x);
      b.minY = Math.min(b.minY, p.y);
      b.maxX = Math.max(b.maxX, p.x);
      b.maxY = Math.max(b.maxY, p.y);
    }
  }
  return b;
}
