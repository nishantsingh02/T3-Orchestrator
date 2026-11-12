// Dependency graph helpers used by plan validation, the plan review screen and task PATCH.

export interface DepNode {
  key: string;
  dependsOn: readonly string[];
}

/** Dependency keys that point at no node, as `[fromKey, missingKey]` pairs. */
export function unknownDeps(nodes: readonly DepNode[]): Array<[string, string]> {
  const keys = new Set(nodes.map((n) => n.key));
  const out: Array<[string, string]> = [];
  for (const n of nodes) {
    for (const d of n.dependsOn) if (!keys.has(d)) out.push([n.key, d]);
  }
  return out;
}

/** Keys that appear more than once. */
export function duplicateKeys(nodes: readonly DepNode[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.key)) dups.add(n.key);
    seen.add(n.key);
  }
  return [...dups];
}

/**
 * Finds one dependency cycle and returns it as a key path that starts and ends on the
 * same key (e.g. `['T1', 'T3', 'T1']`), or null when the graph is acyclic.
 * Unknown dependency keys are ignored.
 */
export function findCycle(nodes: readonly DepNode[]): string[] | null {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    const s = state.get(key);
    if (s === 'done') return null;
    if (s === 'visiting') return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, 'visiting');
    stack.push(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (!byKey.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(key, 'done');
    return null;
  };

  for (const n of nodes) {
    const cycle = visit(n.key);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Groups keys into waves by topological depth: wave 0 has no (known) dependencies,
 * wave n depends only on earlier waves. Nodes on a cycle are returned in `cyclic`.
 */
export function computeWaves(nodes: readonly DepNode[]): { waves: string[][]; cyclic: string[] } {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const depth = new Map<string, number>();
  const remaining = new Set(nodes.map((n) => n.key));

  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    for (const key of [...remaining]) {
      const deps = (byKey.get(key)?.dependsOn ?? []).filter((d) => byKey.has(d));
      if (deps.every((d) => depth.has(d))) {
        depth.set(key, deps.reduce((m, d) => Math.max(m, depth.get(d)! + 1), 0));
        remaining.delete(key);
        progressed = true;
      }
    }
  }

  const waves: string[][] = [];
  for (const n of nodes) {
    const d = depth.get(n.key);
    if (d === undefined) continue;
    (waves[d] ??= []).push(n.key);
  }
  return { waves: waves.filter(Boolean), cyclic: [...remaining] };
}

/** Would adding `from → to` (from depends on to) create a cycle in the existing graph? */
export function wouldCreateCycle(nodes: readonly DepNode[], from: string, to: string): boolean {
  if (from === to) return true;
  const next = nodes.map((n) => (n.key === from ? { key: n.key, dependsOn: [...n.dependsOn, to] } : n));
  return findCycle(next) !== null;
}
