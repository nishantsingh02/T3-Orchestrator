// What agents read from the knowledge graph. A prompt gets the graph's overview, the nodes that match
// its work (by the words they share, rare words counting more, and by the code paths it touches) with
// their links, and where the files are. The MCP tool searches the same way.
import { KNOWLEDGE_NODE_TYPE_INFO, KNOWLEDGE_NODE_TYPES, type KnowledgeEdge, type KnowledgeGraph, type KnowledgeNode } from '@t3-orchestra/shared';
import { degrees } from './graph.ts';

export interface TextFile {
  id: string;
  name: string;
  path: string;
  status: 'pending' | 'indexed' | 'skipped';
  summary: string | null;
  /** What the user says the file is. */
  description: string | null;
}

const STOP = new Set(
  (
    'the and for with that this from into onto over under have has had are was were will would should could can may might must not but ' +
    'all any each every some such than then them they their there these those what when where which while who whom why how its it ' +
    'our out your you yours use used using make made new add adds added also only more most other others same very just like get set ' +
    'one two via per see about after before between both does done being been task tasks work file files code project board agent'
  ).split(' '),
);

const normalize = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Words worth matching on: three letters or more, no stop words, a plural "s" taken off. */
export function terms(text: string): string[] {
  return normalize(text)
    .trim()
    .split(' ')
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

const pathOf = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();

export interface Focus {
  text: string;
  /** Repo-relative paths the work touches. */
  paths?: string[];
}

export interface Scored {
  node: KnowledgeNode;
  score: number;
}

/**
 * Nodes that match `focus`, best first; none below `min`. A word of a node's name counts up to 3, a
 * word of its summary up to 0.75 (2 at most in all), both less the more nodes share the word; the
 * whole name in the text adds 4, a code path the work touches 3. With the default `min`, one rare
 * word of the name is enough, a common one is not.
 */
export function rankNodes(nodes: readonly KnowledgeNode[], focus: Focus, min = 2.4): Scored[] {
  const focusText = normalize(focus.text);
  const focusTerms = new Set(terms(focus.text));
  const focusPaths = (focus.paths ?? []).map(pathOf).filter(Boolean);
  if (focusTerms.size === 0 && focusPaths.length === 0) return [];

  // Rare words say more: "refund" picks out a node, "user" doesn't.
  const nodeTerms = nodes.map((n) => ({
    name: new Set(terms([n.name, ...n.aliases].join(' '))),
    summary: new Set(terms(n.summary)),
  }));
  // Names count against names: "refund" in one name stays rare even when summaries mention refunds.
  const dfName = new Map<string, number>();
  const dfAll = new Map<string, number>();
  for (const t of nodeTerms) {
    for (const w of t.name) dfName.set(w, (dfName.get(w) ?? 0) + 1);
    for (const w of new Set([...t.name, ...t.summary])) dfAll.set(w, (dfAll.get(w) ?? 0) + 1);
  }
  // 1 for a word only one node has, towards 0 for one they all have.
  const rarity = (df: ReadonlyMap<string, number>, w: string) => Math.log((nodes.length + 1) / Math.max(df.get(w) ?? 1, 1)) / Math.log(nodes.length + 1);

  const out: Scored[] = [];
  nodes.forEach((node, i) => {
    let score = 0;
    for (const name of [node.name, ...node.aliases]) {
      const n = normalize(name);
      if (n.trim().length >= 3 && focusText.includes(n)) {
        score += 4;
        break;
      }
    }
    for (const w of nodeTerms[i]!.name) if (focusTerms.has(w)) score += 3 * rarity(dfName, w);
    let fromSummary = 0;
    for (const w of nodeTerms[i]!.summary) if (focusTerms.has(w) && !nodeTerms[i]!.name.has(w)) fromSummary += 0.75 * rarity(dfAll, w);
    score += Math.min(fromSummary, 2);
    if (focusPaths.length && node.code.some((c) => focusPaths.some((p) => pathOf(c).startsWith(p) || p.startsWith(pathOf(c))))) score += 3;
    if (score >= min) out.push({ node, score });
  });
  return out.sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name));
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A file in a list: its path, the agent's summary, and the user's description on a line of its own. */
function fileLine(f: TextFile, note: string, max: { summary: number; description: number }): string {
  const head = `- \`${f.path}\`${note}${f.summary ? `: ${clip(f.summary, max.summary)}` : ''}`;
  return f.description ? `${head}\n  The user says: ${clip(f.description.replace(/\s*\n\s*/g, ' '), max.description)}` : head;
}

function sourceText(node: KnowledgeNode, files: ReadonlyMap<string, TextFile>, withQuotes: boolean): string {
  const parts = node.sources.slice(0, 3).flatMap((s) => {
    const f = files.get(s.fileId);
    if (!f) return [];
    const where = s.where ? `, ${s.where}` : '';
    const quote = withQuotes && s.quote ? `: “${clip(s.quote, 200)}”` : '';
    return [`${f.name}${where}${quote}`];
  });
  return parts.join('; ');
}

function linkTexts(node: KnowledgeNode, edges: readonly KnowledgeEdge[], names: ReadonlyMap<string, string>, max: number): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if (e.from === node.key && names.has(e.to)) out.push(`${e.relation} **${names.get(e.to)}**`);
    else if (e.to === node.key && names.has(e.from)) out.push(`**${names.get(e.from)}** ${e.relation} this`);
  }
  return out.length > max ? [...out.slice(0, max), `${out.length - max} more`] : out;
}

function nodeLine(node: KnowledgeNode, g: KnowledgeGraph, files: ReadonlyMap<string, TextFile>, names: ReadonlyMap<string, string>): string {
  const type = KNOWLEDGE_NODE_TYPE_INFO[node.type].label;
  const src = sourceText(node, files, false);
  const code = node.code.length ? ` Code: ${node.code.slice(0, 3).map((c) => `\`${c}\``).join(', ')}.` : '';
  const lines = [`- **${node.name}** (${type}): ${clip(node.summary, 500)}${src ? ` _(${src})_` : ''}${code}`];
  const links = linkTexts(node, g.edges, names, 5);
  if (links.length) lines.push(`  Links: ${links.join('; ')}.`);
  return lines.join('\n');
}

export type FocusKind = 'task' | 'plan' | 'question' | 'audit' | 'work';
const FOCUS_LABEL: Record<FocusKind, string> = {
  task: 'this task',
  plan: 'this plan',
  question: 'this question',
  audit: 'this audit',
  work: 'this work',
};

/** Prompt size the knowledge section stays under. */
const MAX_CHARS = 9000;
const MAX_MATCHED = 12;
const MIN_SHOWN = 6;

/**
 * The "Project knowledge" section of an agent prompt, or '' when the board has no context files.
 * `mcpBoard` names the board for the MCP lookup hint.
 */
export function knowledgeText(g: KnowledgeGraph, fileList: readonly TextFile[], focus: Focus, o: { kind: FocusKind; mcpBoard?: string }): string {
  if (fileList.length === 0 && g.nodes.length === 0) return '';
  const files = new Map(fileList.map((f) => [f.id, f]));
  const names = new Map(g.nodes.map((n) => [n.key, n.name]));

  const matched = rankNodes(g.nodes, focus).slice(0, MAX_MATCHED).map((s) => s.node);
  // With little that matches, the best-connected nodes carry the most of the picture.
  const deg = degrees(g);
  const chosen = new Set(matched.map((n) => n.key));
  const central =
    matched.length >= MIN_SHOWN
      ? []
      : g.nodes
          .filter((n) => !chosen.has(n.key) && n.type !== 'term')
          .sort((a, b) => (deg.get(b.key) ?? 0) - (deg.get(a.key) ?? 0) || a.name.localeCompare(b.name))
          .slice(0, MIN_SHOWN + 2 - matched.length);

  const head = [
    '## Project knowledge',
    'The user added files to this board to give you context (specs, notes, documents). T3 Orchestra built a knowledge graph from them; here is its overview and what matches ' +
      `${FOCUS_LABEL[o.kind]}. Follow it unless the code or the task says otherwise; where they disagree, say so in your reply.`,
  ];
  if (g.digest.trim()) head.push(`### Overview\n${g.digest.trim()}`);

  const fileLines = fileList.slice(0, 40).map((f) => {
    const note = f.status === 'pending' ? ' (not read into the graph yet)' : f.status === 'skipped' ? ' (could not be read)' : '';
    return fileLine(f, note, { summary: 160, description: 200 });
  });
  const more = fileList.length > 40 ? [`- … and ${fileList.length - 40} more in the same folder`] : [];
  const lookup = o.mcpBoard
    ? ` If you have the t3orchestra MCP tools, \`context_search\` (board "${o.mcpBoard}") looks up anything else in the graph.`
    : '';
  const tail = `### The files\nOpen one when you need more than the notes above, but don't change anything in their folder: T3 Orchestra keeps it.${lookup}\n${[...fileLines, ...more].join('\n')}`;

  const sections = (m: KnowledgeNode[], c: KnowledgeNode[]) => {
    const out = [...head];
    if (m.length) out.push(`### Relevant to ${FOCUS_LABEL[o.kind]}\n${m.map((n) => nodeLine(n, g, files, names)).join('\n')}`);
    if (c.length) out.push(`### ${m.length ? 'Also central' : 'Central points'}\n${c.map((n) => nodeLine(n, g, files, names)).join('\n')}`);
    out.push(tail);
    return out.join('\n\n');
  };
  // Drop the least relevant nodes until it fits.
  let m = matched;
  let c = central;
  let text = sections(m, c);
  while (text.length > MAX_CHARS && (m.length || c.length)) {
    if (c.length) c = c.slice(0, -1);
    else m = m.slice(0, -1);
    text = sections(m, c);
  }
  return text;
}

/** The MCP `context_search` answer: matching nodes in full, or an outline of the graph for an empty query. */
export function searchText(g: KnowledgeGraph, fileList: readonly TextFile[], query: string, limit = 10): string {
  const files = new Map(fileList.map((f) => [f.id, f]));
  const names = new Map(g.nodes.map((n) => [n.key, n.name]));
  if (g.nodes.length === 0) {
    return fileList.length
      ? `The board has ${fileList.length} context file(s) but no knowledge graph yet. Files:\n${fileList.map((f) => fileLine(f, '', { summary: 300, description: 1000 })).join('\n')}`
      : 'This board has no context files and no knowledge graph.';
  }
  const q = query.trim();
  if (!q) {
    const byType = KNOWLEDGE_NODE_TYPES.map((t) => {
      const list = g.nodes.filter((n) => n.type === t);
      return list.length ? `**${KNOWLEDGE_NODE_TYPE_INFO[t].label}** (${list.length}): ${list.slice(0, 25).map((n) => n.name).join(', ')}${list.length > 25 ? ', …' : ''}` : '';
    }).filter(Boolean);
    return [`## Overview\n${g.digest.trim() || '(none)'}`, `## Nodes\n${byType.join('\n')}`, 'Search with a query to get the details of a node.'].join('\n\n');
  }
  const hits = rankNodes(g.nodes, { text: q }, 1).slice(0, limit);
  if (!hits.length) return `Nothing in the knowledge graph matches "${q}". Call again with no query for an outline of what it holds.`;
  return hits
    .map(({ node }) => {
      const out = [`### ${node.name}`, `${KNOWLEDGE_NODE_TYPE_INFO[node.type].label} · key \`${node.key}\``, node.summary];
      if (node.aliases.length) out.push(`Also called: ${node.aliases.join(', ')}`);
      const src = sourceText(node, files, true);
      if (src) out.push(`Sources: ${src}`);
      if (node.code.length) out.push(`Code: ${node.code.map((c) => `\`${c}\``).join(', ')}`);
      const links = linkTexts(node, g.edges, names, 12);
      if (links.length) out.push(`Links: ${links.join('; ')}`);
      return out.join('\n');
    })
    .join('\n\n');
}
