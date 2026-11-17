// The knowledge graph as data: taking out what a file said, and adding a build's result. Pure functions,
// so the rules are easy to test; the service loads and saves the graph around them.
import type { KnowledgeBuildStats, KnowledgeEdge, KnowledgeNode, KnowledgeResult, KnowledgeSource } from '@t3-orchestra/shared';

export interface GraphParts {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

export interface FileRef {
  id: string;
  name: string;
}

const MAX_ALIASES = 12;
const MAX_SOURCES = 16;
const MAX_CODE = 10;

export const edgeId = (e: Pick<KnowledgeEdge, 'from' | 'relation' | 'to'>) => `${e.from}|${e.relation}|${e.to}`;

/**
 * Takes out what the given files said: their sources and the edges they stated. A node left with no
 * source goes, with every edge that touches it.
 */
export function dropFiles(g: GraphParts, fileIds: ReadonlySet<string>): GraphParts {
  if (fileIds.size === 0) return g;
  const nodes = g.nodes
    .map((n) => (n.sources.some((s) => fileIds.has(s.fileId)) ? { ...n, sources: n.sources.filter((s) => !fileIds.has(s.fileId)) } : n))
    .filter((n) => n.sources.length > 0);
  const keys = new Set(nodes.map((n) => n.key));
  const edges = g.edges.filter((e) => !(e.fileId && fileIds.has(e.fileId)) && keys.has(e.from) && keys.has(e.to));
  return { nodes, edges };
}

/** Finds a board file from what the agent wrote: its name or a path ending in it, in any case. */
export function fileResolver(files: readonly FileRef[]): (ref: string | undefined | null) => string | null {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f.id]));
  return (ref) => {
    const r = ref?.trim().replace(/^[`'"]+|[`'"]+$/g, '');
    if (!r) return null;
    const base = r.split(/[\\/]/).pop()!.toLowerCase();
    return byName.get(r.toLowerCase()) ?? byName.get(base) ?? null;
  };
}

function uniqueCaseless(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = s.toLowerCase();
    if (!s || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const codePath = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^`|`$/g, '');

function mergeSources(a: KnowledgeSource[], b: KnowledgeSource[]): KnowledgeSource[] {
  const seen = new Set<string>();
  return [...a, ...b]
    .filter((s) => {
      const k = `${s.fileId}|${s.where.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_SOURCES);
}

/**
 * Adds a build's result to `base` (the graph with the build's files already taken out, or empty for a
 * fresh build). A new node needs a source in a known file; a node the graph has gets the new name, type
 * and summary and keeps its other sources. Edges need both ends in the graph. `buildFiles` are the files
 * the build read: an edge with no file named is put on the build's file when it read only one.
 */
export function applyResult(
  base: GraphParts,
  r: Pick<KnowledgeResult, 'nodes' | 'edges'>,
  o: { files: readonly FileRef[]; buildFiles: readonly FileRef[]; now: string },
): { graph: GraphParts; touched: Set<string> } {
  const resolve = fileResolver(o.files);
  const nodes = new Map(base.nodes.map((n) => [n.key, n]));
  const touched = new Set<string>();
  for (const input of r.nodes) {
    const sources = input.sources.flatMap((s) => {
      const fileId = resolve(s.file);
      return fileId ? [{ fileId, where: s.where, quote: s.quote }] : [];
    });
    const prev = nodes.get(input.key);
    if (!prev && sources.length === 0) continue; // nothing behind it
    nodes.set(input.key, {
      key: input.key,
      name: input.name,
      type: input.type,
      summary: input.summary,
      aliases: uniqueCaseless([...(prev?.aliases ?? []), ...input.aliases]).filter((a) => a.toLowerCase() !== input.name.toLowerCase()).slice(0, MAX_ALIASES),
      sources: mergeSources(prev?.sources ?? [], sources),
      code: uniqueCaseless([...(prev?.code ?? []), ...input.code.map(codePath)]).slice(0, MAX_CODE),
      updatedAt: o.now,
    });
    touched.add(input.key);
  }

  const edges = new Map(base.edges.map((e) => [edgeId(e), e]));
  const soleFile = o.buildFiles.length === 1 ? o.buildFiles[0]!.id : null;
  for (const e of r.edges) {
    if (e.from === e.to || !nodes.has(e.from) || !nodes.has(e.to)) continue;
    const edge: KnowledgeEdge = { from: e.from, to: e.to, relation: e.relation.toLowerCase(), fileId: resolve(e.file) ?? soleFile };
    edges.set(edgeId(edge), edge);
  }
  return { graph: { nodes: [...nodes.values()], edges: [...edges.values()] }, touched };
}

/** What a build changed, from the graph before and after it. */
export function buildStats(before: GraphParts, after: GraphParts, touched: ReadonlySet<string>): KnowledgeBuildStats {
  const was = new Set(before.nodes.map((n) => n.key));
  const now = new Set(after.nodes.map((n) => n.key));
  return {
    added: [...now].filter((k) => !was.has(k)).length,
    updated: [...touched].filter((k) => was.has(k) && now.has(k)).length,
    removed: [...was].filter((k) => !now.has(k)).length,
    edges: after.edges.length,
  };
}

/** Links per node. */
export function degrees(g: GraphParts): Map<string, number> {
  const d = new Map<string, number>(g.nodes.map((n) => [n.key, 0]));
  for (const e of g.edges) {
    d.set(e.from, (d.get(e.from) ?? 0) + 1);
    d.set(e.to, (d.get(e.to) ?? 0) + 1);
  }
  return d;
}
