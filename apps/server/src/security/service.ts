// Security view backend: findings (from audits and the two scans) and what the user does with them,
// the scans themselves, the summary the board's tab shows, and the Markdown report.
import {
  findingRef,
  SECURITY_CATEGORY_INFO,
  SECURITY_DISMISS_LABELS,
  SECURITY_SEVERITIES,
  SECURITY_SEVERITY_LABELS,
  SECURITY_SEVERITY_RANK,
  type AuditFinding,
  type BoardSecurityView,
  type Complexity,
  type DismissSecurityFindingBody,
  type Priority,
  type SecurityAuditView,
  type SecurityFindingStatus,
  type SecurityFindingView,
  type SecurityReviewFlagView,
  type SecurityScanKind,
  type SecurityScanView,
  type SecuritySeverity,
  type Severity,
  type Stage,
  type FindingStatus,
} from '@t3-orchestra/shared';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import {
  boards,
  securityAudits,
  securityFindings,
  securityScans,
  tasks,
  type SecurityAuditRow,
  type SecurityFindingRow,
  type SecurityScanRow,
  type TaskRow,
} from '../db/schema.ts';
import { AppError, emitBoard, getBoardOrThrow, type DbOrTx, type EngineContext } from '../engine/context.ts';
import { createTask } from '../engine/tasks.ts';
import * as git from '../git/git.ts';
import { childLog } from '../log.ts';
import { errorMessage, newId, nowIso } from '../util.ts';
import { scanDependencies } from './dependencies.ts';
import type { ScanItem } from './items.ts';
import { scanSecrets } from './secrets.ts';

const log = childLog('security');

const CLOSED_STAGES: Stage[] = ['done', 'discarded'];

// ---------------------------------------------------------------------------
// Views and SSE
// ---------------------------------------------------------------------------

function findingViewOf(
  f: SecurityFindingRow,
  task: { number: number; stage: Stage } | undefined,
  auditNumbers: ReadonlyMap<string, number>,
): SecurityFindingView {
  return {
    id: f.id,
    boardId: f.boardId,
    number: f.number,
    source: f.source,
    auditId: f.auditId,
    auditNumber: f.auditId ? (auditNumbers.get(f.auditId) ?? null) : null,
    severity: f.severity,
    category: f.category,
    title: f.title,
    description: f.description,
    details: f.details,
    recommendation: f.recommendation,
    file: f.file,
    line: f.line,
    cwe: f.cwe,
    confidence: f.confidence,
    acceptanceCriteria: f.acceptanceCriteria,
    touches: f.touches,
    meta: f.meta,
    status: f.status,
    dismissReason: f.dismissReason,
    dismissNote: f.dismissNote,
    taskId: f.taskId,
    taskNumber: task?.number ?? null,
    taskStage: task?.stage ?? null,
    firstSeenAt: f.firstSeenAt,
    lastSeenAt: f.lastSeenAt,
    resolvedAt: f.resolvedAt,
    resolvedBy: f.resolvedBy,
    resolvedAuditNumber: f.resolvedAuditId ? (auditNumbers.get(f.resolvedAuditId) ?? null) : null,
    updatedAt: f.updatedAt,
  };
}

function auditNumbersOf(db: DbOrTx, boardId: string): Map<string, number> {
  return new Map(
    db
      .select({ id: securityAudits.id, n: securityAudits.number })
      .from(securityAudits)
      .where(eq(securityAudits.boardId, boardId))
      .all()
      .map((a) => [a.id, a.n]),
  );
}

export function findingView(db: DbOrTx, f: SecurityFindingRow): SecurityFindingView {
  const task = f.taskId ? db.select({ number: tasks.number, stage: tasks.stage }).from(tasks).where(eq(tasks.id, f.taskId)).get() : undefined;
  return findingViewOf(f, task, auditNumbersOf(db, f.boardId));
}

export function auditView(db: DbOrTx, a: SecurityAuditRow): SecurityAuditView {
  const found = db.select({ id: securityFindings.id }).from(securityFindings).where(eq(securityFindings.auditId, a.id)).all().length;
  const resolved = db.select({ id: securityFindings.id }).from(securityFindings).where(eq(securityFindings.resolvedAuditId, a.id)).all().length;
  return {
    id: a.id,
    boardId: a.boardId,
    number: a.number,
    scope: a.scope,
    focus: a.focus,
    paths: a.paths,
    instructions: a.instructions,
    baseSha: a.baseSha,
    headSha: a.headSha,
    status: a.status,
    threadLink: a.threadLink,
    summary: a.summary,
    attackSurface: a.attackSurface,
    coverage: a.coverage,
    foundCount: found,
    resolvedCount: resolved,
    error: a.error,
    createdAt: a.createdAt,
    finishedAt: a.finishedAt,
  };
}

export function scanView(s: SecurityScanRow): SecurityScanView {
  return {
    id: s.id,
    boardId: s.boardId,
    kind: s.kind,
    status: s.status,
    headSha: s.headSha,
    stats: s.stats,
    newCount: s.newCount,
    fixedCount: s.fixedCount,
    error: s.error,
    createdAt: s.createdAt,
    finishedAt: s.finishedAt,
  };
}

const bySeverity = (a: SecurityFindingRow, b: SecurityFindingRow) =>
  SECURITY_SEVERITY_RANK[a.severity] - SECURITY_SEVERITY_RANK[b.severity] || b.number - a.number;

/** Review findings that read as security issues ("Security: …" when the board asks reviewers for security checks). */
function reviewFlags(ctx: EngineContext, boardId: string): SecurityReviewFlagView[] {
  const rows = ctx.db.$client
    .prepare(
      `SELECT f.id, f.task_id AS taskId, t.number AS taskNumber, t.title AS taskTitle, t.stage AS taskStage, f.round,
              f.severity, f.title, f.file, f.line, f.status
       FROM review_findings f JOIN tasks t ON t.id = f.task_id
       WHERE t.board_id = ? AND (lower(f.title) LIKE 'security%' OR lower(f.title) LIKE '%injection%' OR lower(f.title) LIKE '%xss%'
         OR lower(f.title) LIKE '%csrf%' OR lower(f.title) LIKE '%ssrf%' OR lower(f.title) LIKE '%path traversal%'
         OR lower(f.title) LIKE '%vulnerab%' OR lower(f.title) LIKE '%hard-coded secret%' OR lower(f.title) LIKE '%hardcoded secret%')
       ORDER BY f.rowid DESC LIMIT 50`,
    )
    .all(boardId) as Array<{
    id: string;
    taskId: string;
    taskNumber: number;
    taskTitle: string;
    taskStage: Stage;
    round: number;
    severity: Severity;
    title: string;
    file: string | null;
    line: number | null;
    status: FindingStatus;
  }>;
  return rows;
}

export async function boardSecurity(ctx: EngineContext, boardId: string): Promise<BoardSecurityView> {
  const board = getBoardOrThrow(ctx, boardId);
  const audits = ctx.db.select().from(securityAudits).where(eq(securityAudits.boardId, boardId)).orderBy(desc(securityAudits.number)).all();
  const scans = ctx.db.select().from(securityScans).where(eq(securityScans.boardId, boardId)).orderBy(desc(securityScans.createdAt)).limit(20).all();
  const rows = ctx.db.select().from(securityFindings).where(eq(securityFindings.boardId, boardId)).all().sort(bySeverity);
  const taskIds = rows.map((f) => f.taskId).filter((id): id is string => id !== null);
  const taskInfo = new Map(
    taskIds.length
      ? ctx.db
          .select({ id: tasks.id, number: tasks.number, stage: tasks.stage })
          .from(tasks)
          .where(inArray(tasks.id, taskIds))
          .all()
          .map((t) => [t.id, t])
      : [],
  );
  const numbers = new Map(audits.map((a) => [a.id, a.number]));
  const lastDone = audits.find((a) => a.status === 'done' && a.headSha);
  const commitsSinceAudit = lastDone ? await git.commitsBetween(board.projectPath, lastDone.headSha!).catch(() => null) : null;
  return {
    audits: audits.map((a) => auditView(ctx.db, a)),
    scans: scans.map(scanView),
    findings: rows.map((f) => findingViewOf(f, f.taskId ? taskInfo.get(f.taskId) : undefined, numbers)),
    reviewFlags: reviewFlags(ctx, boardId),
    commitsSinceAudit,
  };
}

export function emitSecurityFinding(ctx: EngineContext, id: string): void {
  const f = ctx.db.select().from(securityFindings).where(eq(securityFindings.id, id)).get();
  if (!f) return;
  ctx.bus.emit('security_finding', findingView(ctx.db, f));
  emitBoard(ctx, f.boardId);
}

export function emitSecurityAudit(ctx: EngineContext, id: string): void {
  const a = ctx.db.select().from(securityAudits).where(eq(securityAudits.id, id)).get();
  if (a) ctx.bus.emit('security_audit', auditView(ctx.db, a));
}

export function emitSecurityScan(ctx: EngineContext, id: string): void {
  const s = ctx.db.select().from(securityScans).where(eq(securityScans.id, id)).get();
  if (s) ctx.bus.emit('security_scan', scanView(s));
}

// ---------------------------------------------------------------------------
// Recording what audits and scans report
// ---------------------------------------------------------------------------

function nextNumber(tx: DbOrTx, boardId: string): number {
  const top = tx.select({ n: max(securityFindings.number) }).from(securityFindings).where(eq(securityFindings.boardId, boardId)).get();
  return (top?.n ?? 0) + 1;
}

function insertFinding(tx: DbOrTx, boardId: string, number: number, item: ScanItem, source: SecurityFindingRow['source'], o: { auditId?: string; scanId?: string }, now: string) {
  const row: SecurityFindingRow = {
    id: newId(),
    boardId,
    number,
    source,
    fingerprint: item.fingerprint,
    auditId: o.auditId ?? null,
    scanId: o.scanId ?? null,
    severity: item.severity,
    category: item.category,
    title: item.title,
    description: item.description,
    details: item.details,
    recommendation: item.recommendation,
    file: item.file,
    line: item.line,
    cwe: item.cwe,
    confidence: item.confidence,
    acceptanceCriteria: item.acceptanceCriteria,
    touches: item.touches,
    meta: item.meta,
    status: 'open',
    dismissReason: null,
    dismissNote: '',
    taskId: null,
    firstSeenAt: now,
    lastSeenAt: now,
    resolvedAt: null,
    resolvedBy: null,
    resolvedAuditId: null,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(securityFindings).values(row).run();
  return row;
}

const contentOf = (item: ScanItem) => ({
  severity: item.severity,
  category: item.category,
  title: item.title,
  description: item.description,
  details: item.details,
  recommendation: item.recommendation,
  file: item.file,
  line: item.line,
  cwe: item.cwe,
  confidence: item.confidence,
  acceptanceCriteria: item.acceptanceCriteria,
  touches: item.touches,
  meta: item.meta,
});

const REOPEN = { status: 'open' as const, resolvedAt: null, resolvedBy: null, resolvedAuditId: null };

/**
 * Matches a scan's items against the board's findings from that scan: new ones are added, known ones
 * updated (a fixed one that is back opens again), and open ones the scan no longer sees are fixed.
 * A dismissed dependency opens again when a new advisory appears for it.
 */
export function applyScan(
  tx: DbOrTx,
  scan: Pick<SecurityScanRow, 'id' | 'boardId' | 'kind'>,
  items: ScanItem[],
  o: { keepHistoryOnly?: boolean } = {},
): { created: number; fixed: number; reopened: number } {
  const now = nowIso();
  const existing = tx
    .select()
    .from(securityFindings)
    .where(and(eq(securityFindings.boardId, scan.boardId), eq(securityFindings.source, scan.kind)))
    .all();
  const byFp = new Map(existing.map((f) => [f.fingerprint, f]));
  const seen = new Set<string>();
  let number = nextNumber(tx, scan.boardId);
  let created = 0;
  let fixed = 0;
  let reopened = 0;
  for (const item of items) {
    if (seen.has(item.fingerprint)) continue;
    seen.add(item.fingerprint);
    const f = byFp.get(item.fingerprint);
    if (!f) {
      insertFinding(tx, scan.boardId, number++, item, scan.kind, { scanId: scan.id }, now);
      created++;
      continue;
    }
    let extra: Partial<SecurityFindingRow> = {};
    if (f.status === 'fixed') {
      extra = REOPEN;
      reopened++;
    } else if (f.status === 'dismissed' && f.meta.kind === 'dependency' && item.meta.kind === 'dependency') {
      const known = new Set(f.meta.advisories.flatMap((a) => [a.id, ...a.aliases]));
      if (item.meta.advisories.some((a) => !known.has(a.id))) {
        extra = { ...REOPEN, dismissReason: null, dismissNote: '' };
        reopened++;
      }
    }
    tx.update(securityFindings)
      .set({ ...contentOf(item), ...extra, scanId: scan.id, lastSeenAt: now, updatedAt: now })
      .where(eq(securityFindings.id, f.id))
      .run();
  }
  for (const f of existing) {
    if (seen.has(f.fingerprint) || (f.status !== 'open' && f.status !== 'added')) continue;
    // Without the history, a secret that was only ever in old commits can't be judged.
    if (o.keepHistoryOnly && f.meta.kind === 'secret' && f.meta.inHistoryOnly) continue;
    tx.update(securityFindings).set({ status: 'fixed', resolvedAt: now, resolvedBy: 'scan', updatedAt: now }).where(eq(securityFindings.id, f.id)).run();
    fixed++;
  }
  return { created, fixed, reopened };
}

const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[^a-z0-9/._-]+/g, ' ')
    .trim();

export const auditFingerprint = (f: Pick<AuditFinding, 'file' | 'title'>) => `audit:${norm(f.file)}:${norm(f.title)}`;

export function auditItem(f: AuditFinding): ScanItem {
  return {
    fingerprint: auditFingerprint(f),
    severity: f.severity,
    category: f.category,
    title: f.title,
    description: f.description,
    details: f.details,
    recommendation: f.recommendation,
    file: f.file ?? null,
    line: f.line ?? null,
    cwe: f.cwe ? f.cwe.toUpperCase() : null,
    confidence: f.confidence,
    acceptanceCriteria: f.acceptanceCriteria,
    touches: f.touches.length ? f.touches : f.file ? [f.file] : [],
    meta: { kind: 'audit' },
  };
}

/** An audit's findings and the earlier findings it found fixed (`resolved`, as "S-3" references). */
export function recordAudit(tx: DbOrTx, audit: Pick<SecurityAuditRow, 'id' | 'boardId'>, findings: AuditFinding[], resolved: string[]) {
  const now = nowIso();
  const existing = tx
    .select()
    .from(securityFindings)
    .where(and(eq(securityFindings.boardId, audit.boardId), eq(securityFindings.source, 'audit')))
    .all();
  const byFp = new Map(existing.map((f) => [f.fingerprint, f]));
  const reported = new Set<string>();
  let number = nextNumber(tx, audit.boardId);
  for (const raw of findings) {
    const item = auditItem(raw);
    if (reported.has(item.fingerprint)) continue;
    reported.add(item.fingerprint);
    const f = byFp.get(item.fingerprint);
    if (!f) {
      insertFinding(tx, audit.boardId, number++, item, 'audit', { auditId: audit.id }, now);
      continue;
    }
    // Reported again: a fixed one is back (with today's wording); the others are just seen again.
    const set: Partial<SecurityFindingRow> = f.status === 'fixed' ? { ...contentOf(item), ...REOPEN } : {};
    tx.update(securityFindings).set({ ...set, lastSeenAt: now, updatedAt: now }).where(eq(securityFindings.id, f.id)).run();
  }
  const numbers = new Set(resolved.map((r) => Number(/(\d+)/.exec(r)?.[1])).filter((n) => Number.isInteger(n)));
  for (const f of existing) {
    if (!numbers.has(f.number) || reported.has(f.fingerprint) || (f.status !== 'open' && f.status !== 'added')) continue;
    tx.update(securityFindings)
      .set({ status: 'fixed', resolvedAt: now, resolvedBy: 'audit', resolvedAuditId: audit.id, updatedAt: now })
      .where(eq(securityFindings.id, f.id))
      .run();
  }
}

// ---------------------------------------------------------------------------
// What the user does with a finding
// ---------------------------------------------------------------------------

function getFindingOrThrow(ctx: EngineContext, id: string): SecurityFindingRow {
  const f = ctx.db.select().from(securityFindings).where(eq(securityFindings.id, id)).get();
  if (!f) throw new AppError('NOT_FOUND', `finding ${id} not found`, 404);
  return f;
}

/** The task a finding is on, unless that task is closed (done or discarded) or gone. */
function liveTask(ctx: EngineContext, f: SecurityFindingRow) {
  if (!f.taskId) return null;
  const t = ctx.db.select({ number: tasks.number, stage: tasks.stage }).from(tasks).where(eq(tasks.id, f.taskId)).get();
  return t && !CLOSED_STAGES.includes(t.stage) ? t : null;
}

const PRIORITY: Record<SecuritySeverity, Priority> = { critical: 'high', high: 'high', medium: 'medium', low: 'low', info: 'low' };
const COMPLEXITY: Record<SecurityFindingRow['source'], Complexity> = { audit: 'medium', secrets: 'small', dependencies: 'small' };

function taskTitle(f: SecurityFindingRow): string {
  if (f.meta.kind === 'dependency') {
    const { name, fixedIn, advisories } = f.meta;
    const n = advisories.length;
    return fixedIn ? `Upgrade ${name} to ${fixedIn} (${n} ${n === 1 ? 'advisory' : 'advisories'})` : `Mitigate the ${name} vulnerabilit${n === 1 ? 'y' : 'ies'}`;
  }
  if (f.meta.kind === 'secret') return f.meta.rule === 'env_file' ? `Stop tracking ${f.file}` : `${f.meta.inHistoryOnly ? 'Rotate' : 'Rotate and remove'}: ${f.title}`;
  return `Security: ${f.title}`;
}

/** "Add to board": the finding becomes a Backlog task. */
export function addFindingToBoard(ctx: EngineContext, id: string): { finding: SecurityFindingRow; task: TaskRow } {
  const f = getFindingOrThrow(ctx, id);
  if (f.status === 'fixed') throw new AppError('ILLEGAL_TRANSITION', 'This finding is fixed. Reopen it first.', 409);
  const open = liveTask(ctx, f);
  if (open) throw new AppError('ILLEGAL_TRANSITION', `This finding is already #${open.number} on the board.`, 409);
  const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : null;
  const source = f.source === 'audit' ? 'security audit' : f.source === 'secrets' ? 'secret scan' : 'dependency scan';
  const description = [
    f.description.trim(),
    where && `**Where:** ${where}`,
    f.details.trim() && `### Details\n\n${f.details.trim()}`,
    f.recommendation.trim() && `### How to fix\n\n${f.recommendation.trim()}`,
    `_From Security (${findingRef(f.number)}, ${source}): ${SECURITY_SEVERITY_LABELS[f.severity].toLowerCase()} severity, ${SECURITY_CATEGORY_INFO[f.category].label}${f.cwe ? `, ${f.cwe}` : ''}._`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const task = createTask(
    ctx,
    f.boardId,
    {
      title: taskTitle(f).slice(0, 120),
      description,
      acceptanceCriteria: f.acceptanceCriteria.length ? f.acceptanceCriteria : ['The issue described above can no longer be reproduced', 'The tests pass'],
      dependsOn: [],
      complexity: COMPLEXITY[f.source],
      category: 'bug',
      priority: PRIORITY[f.severity],
      touches: f.touches,
      providerOverride: null,
      modelOverride: null,
      skipAiReview: false,
      milestoneId: null,
    },
    { stage: 'backlog' },
  );
  ctx.db
    .update(securityFindings)
    .set({ status: 'added', taskId: task.id, dismissReason: null, dismissNote: '', updatedAt: nowIso() })
    .where(eq(securityFindings.id, f.id))
    .run();
  emitSecurityFinding(ctx, f.id);
  return { finding: getFindingOrThrow(ctx, f.id), task };
}

/** Where an un-dismissed or reopened finding goes back to: its task when that is still open. */
function restingStatus(ctx: EngineContext, f: SecurityFindingRow): SecurityFindingStatus {
  return liveTask(ctx, f) ? 'added' : 'open';
}

export function dismissFinding(ctx: EngineContext, id: string, body: DismissSecurityFindingBody): SecurityFindingRow {
  const f = getFindingOrThrow(ctx, id);
  const now = nowIso();
  if (body.undo) {
    if (f.status === 'dismissed') {
      ctx.db.update(securityFindings).set({ status: restingStatus(ctx, f), dismissReason: null, dismissNote: '', updatedAt: now }).where(eq(securityFindings.id, id)).run();
    }
  } else {
    if (f.status === 'fixed') throw new AppError('ILLEGAL_TRANSITION', 'This finding is already fixed.', 409);
    ctx.db.update(securityFindings).set({ status: 'dismissed', dismissReason: body.reason, dismissNote: body.note, updatedAt: now }).where(eq(securityFindings.id, id)).run();
  }
  emitSecurityFinding(ctx, id);
  return getFindingOrThrow(ctx, id);
}

/** The user says it is fixed (or, with `undo`, that it isn't). The next audit or scan has the last word. */
export function markFindingFixed(ctx: EngineContext, id: string, undo: boolean): SecurityFindingRow {
  const f = getFindingOrThrow(ctx, id);
  const now = nowIso();
  if (undo) {
    if (f.status === 'fixed') ctx.db.update(securityFindings).set({ ...REOPEN, status: restingStatus(ctx, f), updatedAt: now }).where(eq(securityFindings.id, id)).run();
  } else if (f.status !== 'fixed') {
    ctx.db
      .update(securityFindings)
      .set({ status: 'fixed', resolvedAt: now, resolvedBy: 'user', resolvedAuditId: null, dismissReason: null, dismissNote: '', updatedAt: now })
      .where(eq(securityFindings.id, id))
      .run();
  }
  emitSecurityFinding(ctx, id);
  return getFindingOrThrow(ctx, id);
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

const scanning = new Set<string>();
const SCAN_LABEL: Record<SecurityScanKind, string> = { secrets: 'secret scan', dependencies: 'dependency scan' };

/** Starts a scan in the background; `done` settles when it has been recorded. */
export async function beginScan(ctx: EngineContext, boardId: string, kind: SecurityScanKind): Promise<{ scan: SecurityScanRow; done: Promise<void> }> {
  const board = getBoardOrThrow(ctx, boardId);
  const key = `${boardId}:${kind}`;
  if (scanning.has(key)) throw new AppError('ILLEGAL_TRANSITION', `The ${SCAN_LABEL[kind]} is already running.`, 409);
  scanning.add(key);
  try {
    const scan: SecurityScanRow = {
      id: newId(),
      boardId,
      kind,
      status: 'running',
      headSha: await git.headSha(board.projectPath),
      stats: {},
      newCount: 0,
      fixedCount: 0,
      error: null,
      createdAt: nowIso(),
      finishedAt: null,
    };
    ctx.db.insert(securityScans).values(scan).run();
    emitSecurityScan(ctx, scan.id);
    const done = runScan(ctx, scan, board.projectPath).finally(() => scanning.delete(key));
    return { scan, done };
  } catch (err) {
    scanning.delete(key);
    throw err;
  }
}

async function runScan(ctx: EngineContext, scan: SecurityScanRow, root: string): Promise<void> {
  try {
    const result = scan.kind === 'secrets' ? await scanSecrets(root) : await scanDependencies(root, ctx.fetch);
    const keepHistoryOnly = 'historyRead' in result && !result.historyRead;
    ctx.db.transaction((tx) => {
      const r = applyScan(tx, scan, result.items, { keepHistoryOnly });
      tx.update(securityScans)
        .set({ status: 'done', stats: result.stats, newCount: r.created + r.reopened, fixedCount: r.fixed, finishedAt: nowIso() })
        .where(eq(securityScans.id, scan.id))
        .run();
    });
    log.info({ boardId: scan.boardId, kind: scan.kind, items: result.items.length }, 'security scan finished');
  } catch (err) {
    log.warn({ boardId: scan.boardId, kind: scan.kind, err: errorMessage(err) }, 'security scan failed');
    ctx.db.update(securityScans).set({ status: 'failed', error: errorMessage(err), finishedAt: nowIso() }).where(eq(securityScans.id, scan.id)).run();
  }
  emitSecurityScan(ctx, scan.id);
  emitBoard(ctx, scan.boardId);
}

/** Scans cut off by a restart. */
export function recoverScans(ctx: EngineContext): void {
  ctx.db
    .update(securityScans)
    .set({ status: 'failed', error: 'Interrupted by a server restart.', finishedAt: nowIso() })
    .where(eq(securityScans.status, 'running'))
    .run();
}

const CHECK_EVERY_MS = 30 * 60_000;
const RESCAN_AFTER_MS = 24 * 3_600_000;
const MIN_GAP_MS = 10 * 60_000;

/** Boards with auto-scan on: both scans again when the checkout moved to another commit, or daily. */
export class SecurityRefresher {
  private first: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly ctx: EngineContext) {}

  start(): void {
    this.first = setTimeout(() => void this.tick(), 2 * 60_000);
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  async tick(nowMs = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let started = 0;
    try {
      const list = this.ctx.db.select().from(boards).where(eq(boards.securityAutoScan, true)).all();
      for (const board of list) {
        if (board.archivedAt) continue;
        const head = await git.headSha(board.projectPath).catch(() => null);
        for (const kind of ['secrets', 'dependencies'] as const) {
          const last = this.ctx.db
            .select()
            .from(securityScans)
            .where(and(eq(securityScans.boardId, board.id), eq(securityScans.kind, kind)))
            .orderBy(desc(securityScans.createdAt))
            .limit(1)
            .get();
          const age = last ? nowMs - Date.parse(last.createdAt) : Infinity;
          const due = !last || age > RESCAN_AFTER_MS || (head !== null && last.headSha !== head && age > MIN_GAP_MS);
          if (!due || last?.status === 'running') continue;
          try {
            const { done } = await beginScan(this.ctx, board.id, kind);
            started++;
            await done;
          } catch (err) {
            log.warn({ boardId: board.id, kind, err: errorMessage(err) }, 'auto scan not started');
          }
        }
      }
      return started;
    } finally {
      this.running = false;
    }
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const ago = (iso: string | null) => (iso ? iso.slice(0, 10) : 'never');

export async function securityReport(ctx: EngineContext, boardId: string): Promise<{ filename: string; text: string }> {
  const board = getBoardOrThrow(ctx, boardId);
  const view = await boardSecurity(ctx, boardId);
  const head = await git.headSha(board.projectPath).catch(() => null);
  const f = view.findings;
  const open = f.filter((x) => x.status === 'open');
  const added = f.filter((x) => x.status === 'added');
  const fixed = f.filter((x) => x.status === 'fixed');
  const dismissed = f.filter((x) => x.status === 'dismissed');
  const count = (list: SecurityFindingView[]) =>
    SECURITY_SEVERITIES.map((s) => [s, list.filter((x) => x.severity === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`)
      .join(', ') || 'none';
  const lastAudit = view.audits.find((a) => a.status === 'done');
  const lastScan = (kind: SecurityScanKind) => view.scans.find((s) => s.kind === kind && s.status === 'done');
  const secrets = lastScan('secrets');
  const deps = lastScan('dependencies');
  const loc = (x: SecurityFindingView) => (x.file ? `\`${x.file}${x.line ? `:${x.line}` : ''}\`` : '—');
  const src = (x: SecurityFindingView) => (x.source === 'audit' ? `audit #${x.auditNumber ?? '?'}` : x.source === 'secrets' ? 'secret scan' : 'dependency scan');
  const lines: string[] = [
    `# Security report: ${board.name}`,
    '',
    `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by T3 Orchestra · \`${board.projectPath}\`${head ? ` at \`${head.slice(0, 10)}\`` : ''}`,
    '',
    '## Summary',
    '',
    `- **Open:** ${open.length} (${count(open)})`,
    `- **Being fixed on the board:** ${added.length} · **Fixed:** ${fixed.length} · **Dismissed:** ${dismissed.length}`,
    `- **Latest audit:** ${lastAudit ? `#${lastAudit.number}, ${ago(lastAudit.finishedAt)}${view.commitsSinceAudit ? ` (${view.commitsSinceAudit} commits since)` : ''}` : 'none yet'}`,
    `- **Secret scan:** ${secrets ? `${ago(secrets.finishedAt)}, ${secrets.stats.files ?? 0} files and ${secrets.stats.commits ?? 0} commits read` : 'not run'}`,
    `- **Dependency scan:** ${deps ? `${ago(deps.finishedAt)}, ${deps.stats.packages ?? 0} packages in ${deps.stats.lockfiles?.length ?? 0} lockfiles, ${deps.stats.vulnerable ?? 0} vulnerable` : 'not run'}`,
  ];
  if (lastAudit?.summary) lines.push('', `### What the latest audit concluded`, '', lastAudit.summary.trim());
  if (open.length) {
    lines.push('', '## Open findings');
    for (const x of open) {
      lines.push(
        '',
        `### ${findingRef(x.number)} · ${SECURITY_SEVERITY_LABELS[x.severity]} · ${x.title}`,
        '',
        `**Where:** ${loc(x)} · **Category:** ${SECURITY_CATEGORY_INFO[x.category].label} · **Found by:** ${src(x)}${x.cwe ? ` · **${x.cwe}**` : ''}`,
        '',
        x.description.trim(),
      );
      if (x.details.trim()) lines.push('', x.details.trim());
      if (x.recommendation.trim()) lines.push('', `**How to fix:** ${x.recommendation.trim()}`);
    }
  }
  if (added.length) {
    lines.push('', '## Being fixed on the board', '');
    for (const x of added) lines.push(`- ${findingRef(x.number)} · ${SECURITY_SEVERITY_LABELS[x.severity]} · ${x.title}${x.taskNumber ? ` → task #${x.taskNumber} (${x.taskStage?.replace('_', ' ')})` : ''}`);
  }
  if (dismissed.length) {
    lines.push('', '## Dismissed', '');
    for (const x of dismissed) {
      lines.push(`- ${findingRef(x.number)} · ${SECURITY_SEVERITY_LABELS[x.severity]} · ${x.title} — ${x.dismissReason ? SECURITY_DISMISS_LABELS[x.dismissReason] : 'dismissed'}${x.dismissNote ? `: ${x.dismissNote}` : ''}`);
    }
  }
  if (fixed.length) {
    lines.push('', '## Fixed', '');
    for (const x of fixed) {
      const by = x.resolvedBy === 'audit' ? `audit #${x.resolvedAuditNumber ?? '?'}` : x.resolvedBy === 'scan' ? 'the scan' : 'marked by hand';
      lines.push(`- ${findingRef(x.number)} · ${x.title} — ${ago(x.resolvedAt)}, ${by}`);
    }
  }
  if (lastAudit?.attackSurface?.trim()) lines.push('', '## Attack surface (latest audit)', '', lastAudit.attackSurface.trim());
  if (lastAudit?.coverage.length) {
    lines.push('', '## What the latest audit checked', '', '| Area | Result | Note |', '| --- | --- | --- |');
    for (const c of lastAudit.coverage) lines.push(`| ${c.area} | ${c.status.replace('_', ' ')} | ${c.note.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  }
  const date = new Date().toISOString().slice(0, 10);
  return { filename: `${board.slug}-security-${date}.md`, text: lines.join('\n') + '\n' };
}
