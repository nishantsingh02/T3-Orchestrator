// Result block extraction + validation (spec §9.1).
import {
  AuditResult,
  formatZodIssues,
  IdeasResult,
  ImplementResult,
  ImportResult,
  KnowledgeResult,
  MarketingResult,
  PlanResult,
  ReviewResult,
  SpecResult,
  type IdeasResult as IdeasResultT,
  type ImplementResult as ImplementResultT,
  type ImportResult as ImportResultT,
  type KnowledgeResult as KnowledgeResultT,
  type MarketingResult as MarketingResultT,
  type PlanResult as PlanResultT,
  type ReviewResult as ReviewResultT,
  type SpecResult as SpecResultT,
  type AuditResult as AuditResultT,
} from '@t3-orchestra/shared';
import type { z } from 'zod';

// yardmaster-result and t3board-result: names before the renames, still written by older threads and overridden prompts.
const FENCE_RE = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*(?:t3orchestra|yardmaster|t3board)-result[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\2[ \t]*(?=\r?\n|$)/g;

/**
 * Returns the body of the LAST ```t3orchestra-result block across the given assistant messages
 * (in chronological order), or null when there is none.
 */
export function extractResultBlock(messages: readonly string[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i] ?? '';
    let last: string | null = null;
    for (const m of text.matchAll(FENCE_RE)) last = m[3] ?? '';
    if (last !== null) return last.trim();
  }
  return null;
}

export type ParseOutcome<T> =
  | { ok: true; value: T; raw: string }
  | { ok: false; raw: string | null; errors: string[]; missing: boolean };

function parseWith<S extends z.ZodType>(schema: S, messages: readonly string[]): ParseOutcome<z.infer<S>> {
  const raw = extractResultBlock(messages);
  if (raw === null) return { ok: false, raw: null, errors: ['no ```t3orchestra-result``` block found'], missing: true };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, raw, errors: [`result block is not valid JSON: ${(err as Error).message}`], missing: false };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, raw, errors: formatZodIssues(parsed.error), missing: false };
  return { ok: true, value: parsed.data, raw };
}

export const parsePlanResult = (m: readonly string[]): ParseOutcome<PlanResultT> => parseWith(PlanResult, m);
export const parseSpecResult = (m: readonly string[]): ParseOutcome<SpecResultT> => parseWith(SpecResult, m);
export const parseImplementResult = (m: readonly string[]): ParseOutcome<ImplementResultT> => parseWith(ImplementResult, m);
export const parseReviewResult = (m: readonly string[]): ParseOutcome<ReviewResultT> => parseWith(ReviewResult, m);
export const parseIdeasResult = (m: readonly string[]): ParseOutcome<IdeasResultT> => parseWith(IdeasResult, m);
export const parseMarketingResult = (m: readonly string[]): ParseOutcome<MarketingResultT> => parseWith(MarketingResult, m);
export const parseImportResult = (m: readonly string[]): ParseOutcome<ImportResultT> => parseWith(ImportResult, m);
export const parseAuditResult = (m: readonly string[]): ParseOutcome<AuditResultT> => parseWith(AuditResult, m);
export const parseKnowledgeResult = (m: readonly string[]): ParseOutcome<KnowledgeResultT> => parseWith(KnowledgeResult, m);
