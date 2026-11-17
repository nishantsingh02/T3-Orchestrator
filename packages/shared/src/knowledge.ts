// Context view: files the user adds to a board (specs, notes, PDFs, screenshots…) and the knowledge graph
// a read-only agent builds from them. Every agent T3 Orchestra starts on the board reads the graph's overview
// and the parts that match its work.
import { z } from 'zod';

/** What a node in the graph is. */
export const KNOWLEDGE_NODE_TYPES = [
  'requirement',
  'decision',
  'constraint',
  'feature',
  'component',
  'data',
  'integration',
  'actor',
  'term',
  'question',
] as const;
export type KnowledgeNodeType = (typeof KNOWLEDGE_NODE_TYPES)[number];
export const KNOWLEDGE_NODE_TYPE_INFO: Record<KnowledgeNodeType, { label: string; blurb: string }> = {
  requirement: { label: 'Requirement', blurb: 'Something the product must do or be.' },
  decision: { label: 'Decision', blurb: 'A choice already made, and why.' },
  constraint: { label: 'Constraint', blurb: 'A rule or limit every change must respect: tech, legal, budget, performance.' },
  feature: { label: 'Feature', blurb: 'A capability, screen or flow users see.' },
  component: { label: 'Component', blurb: 'A part of the system: an app, service, module or page.' },
  data: { label: 'Data', blurb: 'A data entity, field, file format or schema.' },
  integration: { label: 'Integration', blurb: 'An outside service, API or tool it talks to.' },
  actor: { label: 'Actor', blurb: 'A kind of user, a persona, role, team or stakeholder.' },
  term: { label: 'Term', blurb: 'Domain vocabulary and what it means here.' },
  question: { label: 'Open question', blurb: 'Unresolved, unclear, or where sources disagree.' },
};

/** Relations the agent is asked to prefer (it may use others). */
export const KNOWLEDGE_RELATIONS = [
  'part of',
  'depends on',
  'uses',
  'implements',
  'constrains',
  'decided by',
  'owned by',
  'used by',
  'produces',
  'stores',
  'refines',
  'replaces',
  'conflicts with',
  'relates to',
] as const;

/** `pending`: not in the graph yet (new or changed since); `skipped`: the agent could not read it. */
export const KNOWLEDGE_FILE_STATUSES = ['pending', 'indexed', 'skipped'] as const;
export type KnowledgeFileStatus = (typeof KNOWLEDGE_FILE_STATUSES)[number];

/** `waiting`: the agent asks for something in T3. */
export const KNOWLEDGE_BUILD_STATUSES = ['running', 'waiting', 'done', 'failed'] as const;
export type KnowledgeBuildStatus = (typeof KNOWLEDGE_BUILD_STATUSES)[number];

/** How the page shows a file and whether the agent can read it as is. */
export type KnowledgeFileKind = 'text' | 'pdf' | 'image' | 'office' | 'other';

const TEXT_EXTS = new Set(
  (
    'md markdown mdx txt text csv tsv json jsonl ndjson yaml yml toml ini cfg conf env xml html htm rst adoc asciidoc org tex log sql ' +
    'graphql gql proto ts tsx js jsx mjs cjs py go rs java kt kts cs rb php swift c cc cpp h hpp m scala sh bash zsh ps1 bat cmd ' +
    'css scss sass less vue svelte astro dart lua r jl ex exs erl hs clj tf hcl dockerfile makefile gradle properties'
  ).split(' '),
);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'doc', 'xls', 'ppt']);

export function knowledgeFileKind(name: string): KnowledgeFileKind {
  const base = name.toLowerCase();
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : base;
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (OFFICE_EXTS.has(ext)) return 'office';
  if (TEXT_EXTS.has(ext) || dot < 0) return 'text';
  return 'other';
}

/** Largest file the page takes: GitHub refuses bigger ones, and the files are meant to be committed. */
export const MAX_KNOWLEDGE_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_KNOWLEDGE_FILE_MB = MAX_KNOWLEDGE_FILE_BYTES / 1024 / 1024;
export const MAX_KNOWLEDGE_FILES = 300;
/** Longest description the user can give a file (it rides in the upload's query string). */
export const MAX_KNOWLEDGE_DESCRIPTION = 1000;

/** "Payment retries" → "payment-retries": how node keys are written. */
export function knowledgeKey(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

// ---------------------------------------------------------------------------
// The agent's result block
// ---------------------------------------------------------------------------

/** Trimmed, and cut at `max` instead of failing: a long summary isn't worth a correction round. */
const clipped = (max: number) => z.string().trim().transform((s) => (s.length > max ? `${s.slice(0, max - 1)}…` : s));
const capped = <T extends z.ZodType>(item: T, max: number) => z.array(item).transform((a) => a.slice(0, max));

const nodeType = z
  .string()
  .trim()
  .transform((s): KnowledgeNodeType => {
    const t = s.toLowerCase().replace(/[\s-]+/g, '_');
    if ((KNOWLEDGE_NODE_TYPES as readonly string[]).includes(t)) return t as KnowledgeNodeType;
    if (t === 'open_question' || t === 'risk' || t === 'conflict') return 'question';
    if (t === 'person' || t === 'persona' || t === 'role' || t === 'user' || t === 'stakeholder' || t === 'team') return 'actor';
    if (t === 'entity' || t === 'model' || t === 'schema') return 'data';
    if (t === 'service' || t === 'module' || t === 'system' || t === 'page' || t === 'screen') return 'component';
    if (t === 'rule' || t === 'policy' || t === 'limit') return 'constraint';
    return 'term';
  });

const nodeKey = z
  .string()
  .trim()
  .transform(knowledgeKey)
  .refine((k) => k.length > 0, 'must contain letters or digits');

export const KnowledgeSourceInput = z.object({
  /** The file's name as listed in the prompt. */
  file: z.string().trim().min(1),
  /** Page, section or heading. */
  where: clipped(160).default(''),
  /** A short exact quote that backs the node. */
  quote: clipped(400).default(''),
});

export const KnowledgeNodeInput = z.object({
  key: nodeKey,
  name: clipped(120).pipe(z.string().min(1)),
  type: nodeType,
  summary: clipped(700).pipe(z.string().min(1)),
  aliases: capped(clipped(80), 12).default([]),
  sources: capped(KnowledgeSourceInput, 10).default([]),
  /** Repo-relative paths where this lives in the code (checked by the agent). */
  code: capped(clipped(300), 10).default([]),
});
export type KnowledgeNodeInput = z.infer<typeof KnowledgeNodeInput>;

export const KnowledgeEdgeInput = z.object({
  from: nodeKey,
  to: nodeKey,
  relation: clipped(60).pipe(z.string().min(1)),
  /** The file that says so. */
  file: z.string().trim().optional(),
});

export const MAX_BUILD_NODES = 400;
export const MAX_BUILD_EDGES = 800;

export const KnowledgeResult = z.object({
  /** One or two sentences: what this build learned. */
  summary: clipped(600).pipe(z.string().min(1)),
  /** Markdown: what every agent should know from all the context files (replaces the previous one). */
  digest: clipped(8000).pipe(z.string().min(1)),
  files: z
    .array(z.object({ file: z.string().trim().min(1), summary: clipped(600).default(''), skipped: clipped(300).optional() }))
    .default([]),
  nodes: capped(KnowledgeNodeInput, MAX_BUILD_NODES).default([]),
  edges: capped(KnowledgeEdgeInput, MAX_BUILD_EDGES).default([]),
});
export type KnowledgeResult = z.infer<typeof KnowledgeResult>;

// ---------------------------------------------------------------------------
// Stored graph and views
// ---------------------------------------------------------------------------

export interface KnowledgeSource {
  fileId: string;
  where: string;
  quote: string;
}

export interface KnowledgeNode {
  key: string;
  name: string;
  type: KnowledgeNodeType;
  summary: string;
  aliases: string[];
  sources: KnowledgeSource[];
  code: string[];
  updatedAt: string;
}

export interface KnowledgeEdge {
  from: string;
  to: string;
  relation: string;
  /** The file that states it; null when the agent didn't say. */
  fileId: string | null;
}

export interface KnowledgeGraph {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  /** Markdown overview every agent prompt starts from. */
  digest: string;
  updatedAt: string | null;
}

export interface KnowledgeFileView {
  id: string;
  boardId: string;
  name: string;
  size: number;
  kind: KnowledgeFileKind;
  status: KnowledgeFileStatus;
  /** The agent's one-line account of the file. */
  summary: string | null;
  /** What the user says the file is and what matters in it; the agent reads the file with it in mind. */
  description: string | null;
  /** Why it was skipped. */
  note: string | null;
  /** The running build reads it now. */
  reading: boolean;
  /** Nodes that cite it. */
  nodeCount: number;
  /** Absolute path on disk (agents read it there). */
  path: string;
  url: string;
  uploadedAt: string;
  updatedAt: string;
}

export interface KnowledgeBuildStats {
  added: number;
  updated: number;
  removed: number;
  edges: number;
}

export interface KnowledgeBuildView {
  id: string;
  boardId: string;
  number: number;
  status: KnowledgeBuildStatus;
  /** Started over: the graph was replaced, not added to. */
  fresh: boolean;
  fileNames: string[];
  threadLink: string | null;
  summary: string | null;
  stats: KnowledgeBuildStats | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Where git stands on the context folder. */
export interface ContextGitState {
  /** Files under it with changes not committed yet, new ones included. */
  changes: number;
  /** .gitignore keeps it out of git. */
  ignored: boolean;
}

export interface BoardKnowledgeView {
  boardId: string;
  files: KnowledgeFileView[];
  /** Newest first. */
  builds: KnowledgeBuildView[];
  graph: KnowledgeGraph;
  /** The context folder in the project, absolute (files in `files/`, the graph in `graph.json`). */
  dir: string;
  /** The same, repo-relative. */
  folder: string;
  /** Why the folder and the board are out of step, when they are. */
  folderProblem: string | null;
  /** Null when git couldn't tell. */
  git: ContextGitState | null;
}

export const StartKnowledgeBuildBody = z.object({
  /** Read every file again and replace the graph. */
  fresh: z.boolean().default(false),
});
export type StartKnowledgeBuildBody = z.infer<typeof StartKnowledgeBuildBody>;

export const UpdateContextFileBody = z.object({
  /** Empty or null clears it. */
  description: z.string().max(MAX_KNOWLEDGE_DESCRIPTION).nullable(),
  /** A file already in the graph is read again, with the new description. */
  reread: z.boolean().default(false),
});
export type UpdateContextFileBody = z.infer<typeof UpdateContextFileBody>;
