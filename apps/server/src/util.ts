import { randomUUID } from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const newId = () => randomUUID();

export function slugify(input: string, max = 40): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/g, '') || 'task';
}

/** `t3orchestra/<boardSlug>/<num>-<slug>` with `-r<attempt>` for fresh retries (spec §13). */
export function taskBranchName(boardSlug: string, num: number, title: string, attempt = 1): string {
  const base = `t3orchestra/${boardSlug}/${num}-${slugify(title, 40)}`;
  return attempt > 1 ? `${base}-r${attempt}` : base;
}

export function taskMarker(boardShort: string, num: number): string {
  return `[tb ${boardShort}-${num}]`;
}
export function reviewMarker(boardShort: string, num: number, round: number): string {
  return `[tb ${boardShort}-${num} r${round}]`;
}
export function planMarker(boardShort: string, planNumber: number): string {
  return `[tb ${boardShort} plan-${planNumber}]`;
}
export function insightMarker(boardShort: string, chatNumber: number): string {
  return `[tb ${boardShort} ask-${chatNumber}]`;
}
export function ideasMarker(boardShort: string, batchNumber: number): string {
  return `[tb ${boardShort} idea-${batchNumber}]`;
}
export function importMarker(boardShort: string, importNumber: number): string {
  return `[tb ${boardShort} import-${importNumber}]`;
}
export function securityMarker(boardShort: string, auditNumber: number): string {
  return `[tb ${boardShort} sec-${auditNumber}]`;
}
export function knowledgeMarker(boardShort: string, buildNumber: number): string {
  return `[tb ${boardShort} ctx-${buildNumber}]`;
}

export function firstLine(text: string | null | undefined, max = 140): string {
  const line = (text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
