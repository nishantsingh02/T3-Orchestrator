// Path-prefix overlap used by the scheduler's avoidOverlap rule (spec §7).

function normalize(p: string): string {
  let s = p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (s.startsWith('/')) s = s.slice(1);
  return s;
}

/** True when one path is a path-prefix of the other ("src/auth/" overlaps "src/auth/login.ts"). */
export function pathsOverlap(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  if (longer === shorter) return true;
  const base = shorter.endsWith('/') ? shorter : `${shorter}/`;
  return longer.startsWith(base) || longer === shorter.replace(/\/$/, '');
}

/** Two `touches` lists overlap if any pair of entries does. Empty lists never overlap. */
export function touchesOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) for (const y of b) if (pathsOverlap(x, y)) return true;
  return false;
}

/** The broader path of each overlapping pair ("src/auth/" for "src/auth/" vs "src/auth/login.ts"), deduped. */
export function overlapPaths(a: readonly string[], b: readonly string[]): string[] {
  const out = new Set<string>();
  for (const x of a) {
    for (const y of b) {
      if (!pathsOverlap(x, y)) continue;
      const [nx, ny] = [normalize(x), normalize(y)];
      out.add(nx.length <= ny.length ? nx : ny);
    }
  }
  return [...out];
}

/** Does `touches` overlap the touches of any active task? */
export function overlapsActive(touches: readonly string[], active: ReadonlyArray<readonly string[]>): boolean {
  return active.some((t) => touchesOverlap(touches, t));
}
