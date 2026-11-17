// graph.json: the knowledge graph and the file list as the project folder keeps them. Files are named
// instead of the database's ids, so a board on another computer can read it.
import fs from 'node:fs';
import { KNOWLEDGE_FILE_STATUSES, KNOWLEDGE_NODE_TYPES, type KnowledgeGraph, type KnowledgeNode } from '@t3-orchestra/shared';
import { z } from 'zod';
import type { ContextFileRow } from '../db/schema.ts';
import { graphFilePath, writeAtomic } from './files.ts';

export const MANIFEST_VERSION = 1;

const ABOUT =
  'Written by T3 Orchestra: the files in ./files and the knowledge graph its agents built from them. Commit this folder to take the context to another computer.';

// Lenient where a hand edit or an older build could leave gaps; a version from a newer T3 Orchestra is left alone.
const ManifestFile = z.object({
  name: z.string().min(1),
  size: z.number().nonnegative().catch(0),
  sha256: z.string().catch(''),
  status: z.enum(KNOWLEDGE_FILE_STATUSES).catch('pending'),
  summary: z.string().nullable().catch(null),
  // Added after format 1 came out: older files don't have it.
  description: z.string().nullable().catch(null),
  note: z.string().nullable().catch(null),
  uploadedAt: z.string().catch(''),
  updatedAt: z.string().catch(''),
});

const ManifestNode = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(KNOWLEDGE_NODE_TYPES).catch('term'),
  summary: z.string().catch(''),
  aliases: z.array(z.string()).catch([]),
  sources: z.array(z.object({ file: z.string(), where: z.string().catch(''), quote: z.string().catch('') })).catch([]),
  code: z.array(z.string()).catch([]),
  updatedAt: z.string().catch(''),
});

const ManifestEdge = z.object({
  from: z.string(),
  to: z.string(),
  relation: z.string(),
  file: z.string().nullable().catch(null),
});

const Manifest = z.object({
  about: z.string().optional(),
  version: z.number().int(),
  updatedAt: z.string().min(1),
  digest: z.string().catch(''),
  files: z.array(ManifestFile).catch([]),
  nodes: z.array(ManifestNode).catch([]),
  edges: z.array(ManifestEdge).catch([]),
});

export type ManifestFile = z.infer<typeof ManifestFile>;
export type ManifestNode = z.infer<typeof ManifestNode>;
export type ManifestEdge = z.infer<typeof ManifestEdge>;
export type Manifest = z.infer<typeof Manifest>;

export type ManifestRead = { kind: 'missing' } | { kind: 'unreadable'; reason: string } | { kind: 'ok'; manifest: Manifest };

export function manifestFile(f: ContextFileRow): ManifestFile {
  return {
    name: f.name,
    size: f.size,
    sha256: f.sha256,
    status: f.status,
    summary: f.summary,
    description: f.description,
    note: f.note,
    uploadedAt: f.uploadedAt,
    updatedAt: f.updatedAt,
  };
}

/** The database's files and graph, with files named. */
export function toManifest(files: readonly ContextFileRow[], g: KnowledgeGraph): Manifest {
  const names = new Map(files.map((f) => [f.id, f.name]));
  return {
    about: ABOUT,
    version: MANIFEST_VERSION,
    updatedAt: g.updatedAt ?? '',
    digest: g.digest,
    files: [...files].sort((a, b) => a.name.localeCompare(b.name)).map(manifestFile),
    nodes: g.nodes.map((n) => ({
      key: n.key,
      name: n.name,
      type: n.type,
      summary: n.summary,
      aliases: n.aliases,
      sources: n.sources.flatMap((s) => (names.has(s.fileId) ? [{ file: names.get(s.fileId)!, where: s.where, quote: s.quote }] : [])),
      code: n.code,
      updatedAt: n.updatedAt,
    })),
    edges: g.edges.map((e) => ({ from: e.from, to: e.to, relation: e.relation, file: e.fileId ? (names.get(e.fileId) ?? null) : null })),
  };
}

/** The graph with file names turned back into ids; a source in a file `idOf` doesn't know is dropped. */
export function graphFromManifest(m: Pick<Manifest, 'nodes' | 'edges'>, idOf: (name: string) => string | undefined): Pick<KnowledgeGraph, 'nodes' | 'edges'> {
  const nodes: KnowledgeNode[] = m.nodes.map((n) => ({
    ...n,
    sources: n.sources.flatMap((s) => {
      const fileId = idOf(s.file);
      return fileId ? [{ fileId, where: s.where, quote: s.quote }] : [];
    }),
  }));
  return { nodes, edges: m.edges.map((e) => ({ from: e.from, to: e.to, relation: e.relation, fileId: e.file ? (idOf(e.file) ?? null) : null })) };
}

// The last graph.json read or written per project, so a sync that finds it unchanged doesn't parse it again.
const seen = new Map<string, { size: number; mtimeMs: number; read: ManifestRead }>();

export function readManifest(projectPath: string): ManifestRead {
  const file = graphFilePath(projectPath);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    seen.delete(file);
    return { kind: 'missing' };
  }
  const cached = seen.get(file);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.read;
  let read: ManifestRead;
  try {
    const json: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const version = (json as { version?: unknown } | null)?.version;
    if (typeof version === 'number' && version > MANIFEST_VERSION) {
      read = { kind: 'unreadable', reason: `it was written by a newer T3 Orchestra (format ${version})` };
    } else {
      const parsed = Manifest.safeParse(json);
      read = parsed.success ? { kind: 'ok', manifest: parsed.data } : { kind: 'unreadable', reason: parsed.error.issues[0]?.message ?? 'not a graph file' };
    }
  } catch (err) {
    read = { kind: 'unreadable', reason: err instanceof SyntaxError ? 'it is not valid JSON (a merge conflict?)' : String(err) };
  }
  seen.set(file, { size: st.size, mtimeMs: st.mtimeMs, read });
  return read;
}

/**
 * Writes graph.json, unless it already says the same. One that can't be read (a merge conflict, a
 * newer T3 Orchestra's) is the user's to sort out and stays as it is: `skipped`. Throws when the folder
 * can't be written.
 */
export function writeManifest(projectPath: string, m: Manifest): 'written' | 'same' | 'skipped' {
  const file = graphFilePath(projectPath);
  if (readManifest(projectPath).kind === 'unreadable') return 'skipped';
  const text = `${JSON.stringify(m, null, 2)}\n`;
  try {
    if (fs.readFileSync(file, 'utf8') === text) return 'same';
  } catch {
    // Not there yet.
  }
  writeAtomic(file, text);
  const st = fs.statSync(file);
  seen.set(file, { size: st.size, mtimeMs: st.mtimeMs, read: { kind: 'ok', manifest: m } });
  return 'written';
}
