// HTML design options: for a task that leaves a visual or UX choice open, the implementer saves a few
// self-contained mock-up pages and stops before building; the user picks one (or a mix, or asks for
// another round) in Human Review, and the choice goes back to the same thread. Each round's pages live
// in <dataDir>/designs/<taskId>/<round>, outside the repo like the screenshots, and rounds survive
// Retry fresh so older options stay visible.
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_DESIGN_OPTIONS,
  type DesignChoice,
  type DesignOptionInfo,
  type DesignOptionView,
  type DesignRoundView,
  type Stage,
  type StageReason,
} from '@t3-orchestra/shared';
import { and, asc, desc, eq, max } from 'drizzle-orm';
import { designRounds, type DesignRoundRow } from '../db/schema.ts';
import { newId, nowIso } from '../util.ts';
import type { DbOrTx } from './context.ts';

/** What a round's folder may serve: the pages, and files they load from next to them. */
export const DESIGN_FILE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const PAGE_EXTS = new Set(['.html', '.htm']);
const NAME_RE = /^[\w][\w .()-]{0,150}$/;

export function designDir(dataDir: string, taskId: string, round: number): string {
  return path.join(dataDir, 'designs', taskId, String(round));
}

/** Absolute path of one file of a round, or null when it is not a plain servable file in the folder. */
export function designFilePath(dataDir: string, taskId: string, round: number, name: string): string | null {
  if (!Number.isInteger(round) || round < 1) return null;
  if (!NAME_RE.test(name) || !(path.extname(name).toLowerCase() in DESIGN_FILE_TYPES)) return null;
  const file = path.join(designDir(dataDir, taskId, round), name);
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function pageNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && NAME_RE.test(e.name) && PAGE_EXTS.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** "b-top-tabs.html" → "Top tabs" (a leading option letter or number is dropped). */
export function designCaption(name: string): string {
  const words = name
    .replace(/\.[^.]+$/, '')
    .replace(/^(?:[a-z]|\d+)[-_ ]+/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

export const optionLetter = (i: number) => String.fromCharCode(65 + i);

/**
 * The pages in a round's folder, in the order the agent listed them (pages it didn't list follow by
 * name), with its titles and summaries. Empty when the agent saved none.
 */
export function collectOptions(dir: string, listed: readonly DesignOptionInfo[]): DesignOptionInfo[] {
  const pages = pageNames(dir);
  const byName = new Map(pages.map((p) => [p.toLowerCase(), p]));
  const seen = new Set<string>();
  const out: DesignOptionInfo[] = [];
  for (const o of listed) {
    const name = byName.get((o.file.split(/[\\/]/).pop() ?? '').toLowerCase());
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ file: name, title: o.title.trim() || designCaption(name), summary: o.summary.trim() });
  }
  for (const name of pages) {
    if (!seen.has(name)) out.push({ file: name, title: designCaption(name), summary: '' });
  }
  return out.slice(0, MAX_DESIGN_OPTIONS);
}

/** The round the next set of options goes into (rounds count up across attempts). */
export function nextDesignRound(db: DbOrTx, taskId: string): number {
  const row = db.select({ n: max(designRounds.round) }).from(designRounds).where(eq(designRounds.taskId, taskId)).get();
  return (row?.n ?? 0) + 1;
}

export function designRoundsOf(db: DbOrTx, taskId: string): DesignRoundRow[] {
  return db.select().from(designRounds).where(eq(designRounds.taskId, taskId)).orderBy(asc(designRounds.round)).all();
}

export function insertDesignRound(
  tx: DbOrTx,
  r: { taskId: string; runId: string; round: number; question: string | null; summary: string | null; options: DesignOptionInfo[] },
): void {
  tx.insert(designRounds)
    .values({ id: newId(), ...r, status: 'open', choice: null, createdAt: nowIso(), decidedAt: null })
    .run();
}

/** The user's picks as prompt text: each page's path and what to take from it, then their notes. */
export function describeChoice(rounds: readonly DesignRoundRow[], dataDir: string, taskId: string, choice: DesignChoice): string {
  const lines: string[] = [];
  for (const p of choice.picks) {
    const r = rounds.find((x) => x.round === p.round);
    const i = r?.options.findIndex((o) => o.file === p.file) ?? -1;
    const title = i >= 0 ? r!.options[i]!.title : designCaption(p.file);
    const label = i >= 0 ? `option ${optionLetter(i)} "${title}"` : `"${title}"`;
    lines.push(`- Round ${p.round}, ${label}: ${path.join(designDir(dataDir, taskId, p.round), p.file)}`);
    if (p.note) lines.push(`  What to take from it: ${p.note}`);
  }
  if (choice.notes) lines.push(...(lines.length ? [''] : []), 'Their notes:', choice.notes);
  return lines.join('\n');
}

/** The design the user chose to build (the latest one), as prompt text; '' when none was chosen. */
export function chosenDesign(db: DbOrTx, dataDir: string, taskId: string): string {
  const row = db
    .select()
    .from(designRounds)
    .where(and(eq(designRounds.taskId, taskId), eq(designRounds.status, 'chosen')))
    .orderBy(desc(designRounds.round))
    .limit(1)
    .get();
  return row?.choice ? describeChoice(designRoundsOf(db, taskId), dataDir, taskId, row.choice) : '';
}

/** Is the task waiting in Human Review for the user to pick a design? */
export const awaitingDesign = (task: { stage: Stage; stageReason: StageReason | null }) =>
  task.stage === 'human_review' && task.stageReason === 'design_options';

function optionViews(dataDir: string, taskId: string, r: DesignRoundRow): DesignOptionView[] {
  return r.options.flatMap((o, i) => {
    let mtime: number;
    try {
      mtime = fs.statSync(path.join(designDir(dataDir, taskId, r.round), o.file)).mtimeMs;
    } catch {
      return []; // removed since
    }
    return [
      {
        round: r.round,
        file: o.file,
        letter: optionLetter(i),
        title: o.title,
        summary: o.summary,
        url: `/api/tasks/${taskId}/designs/${r.round}/${encodeURIComponent(o.file)}?v=${Math.round(mtime)}`,
      },
    ];
  });
}

export function designRoundViews(
  db: DbOrTx,
  dataDir: string,
  task: { id: string; stage: Stage; stageReason: StageReason | null },
): DesignRoundView[] {
  const rows = designRoundsOf(db, task.id);
  const latest = rows.at(-1);
  const waiting = awaitingDesign(task);
  return rows.map((r) => ({
    id: r.id,
    round: r.round,
    status: r.status,
    awaiting: waiting && r === latest && r.status === 'open',
    question: r.question,
    summary: r.summary,
    options: optionViews(dataDir, task.id, r),
    choice: r.choice ?? null,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  }));
}
