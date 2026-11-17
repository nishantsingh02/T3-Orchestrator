// Context view helpers: node type colors, file icons, and the graph lookups the panels share.
import {
  KNOWLEDGE_NODE_TYPE_INFO,
  type KnowledgeEdge,
  type KnowledgeFileKind,
  type KnowledgeFileView,
  type KnowledgeGraph,
  type KnowledgeNode,
  type KnowledgeNodeType,
} from '@t3-orchestra/shared';
import { File, FileImage, FileSpreadsheet, FileText, FileType2, type LucideIcon } from 'lucide-react';

/** Fill of a node type (CSS custom properties in globals.css, light and dark). */
export const typeColor = (t: KnowledgeNodeType) => `var(--kg-${t})`;
export const typeLabel = (t: KnowledgeNodeType) => KNOWLEDGE_NODE_TYPE_INFO[t].label;

export const FILE_ICONS: Record<KnowledgeFileKind, LucideIcon> = {
  text: FileText,
  pdf: FileType2,
  image: FileImage,
  office: FileSpreadsheet,
  other: File,
};

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A link from one node's side: the relation and the node at the other end. */
export interface Link {
  edge: KnowledgeEdge;
  other: KnowledgeNode;
  outgoing: boolean;
}

export function linksOf(g: KnowledgeGraph, key: string, byKey: ReadonlyMap<string, KnowledgeNode>): Link[] {
  const out: Link[] = [];
  for (const e of g.edges) {
    if (e.from === key && byKey.has(e.to)) out.push({ edge: e, other: byKey.get(e.to)!, outgoing: true });
    else if (e.to === key && byKey.has(e.from)) out.push({ edge: e, other: byKey.get(e.from)!, outgoing: false });
  }
  return out;
}

export function fileName(files: readonly KnowledgeFileView[], id: string | null): string | null {
  return id ? (files.find((f) => f.id === id)?.name ?? null) : null;
}

/** Words of a search box against a node's name, aliases and summary. */
export function matchesSearch(n: KnowledgeNode, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const hay = `${n.name} ${n.aliases.join(' ')} ${n.summary}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Text of a note becomes a Markdown file named after its title. */
export function noteFileName(title: string): string {
  const base = title.trim().replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Note';
  return /\.(md|markdown|txt)$/i.test(base) ? base : `${base}.md`;
}
