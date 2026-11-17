// Security audits: a read-only agent reads the project (all of it, the commits since the last audit,
// or some paths) and reports findings with evidence, the attack surface and what it checked. It also
// re-checks the open findings of earlier audits, and the ones it finds fixed are closed. One T3 thread
// per audit, on the root checkout, like Ideas.
import {
  findingRef,
  SECURITY_AREAS,
  SECURITY_CATEGORY_INFO,
  SECURITY_DISMISS_LABELS,
  SECURITY_SEVERITY_RANK,
  type RunStatus,
  type SecurityArea,
  type SecurityAuditScope,
  type SecurityAuditStatus,
  type StartAuditBody,
} from '@t3-orchestra/shared';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import { securityAudits, securityFindings, tasks, type RunRow, type SecurityAuditRow } from '../db/schema.ts';
import * as git from '../git/git.ts';
import { childLog } from '../log.ts';
import { auditView, emitSecurityAudit, recordAudit } from '../security/service.ts';
import { errorMessage, newId, nowIso, securityMarker } from '../util.ts';
import { AppError, emitBoard, getBoardOrThrow, type EngineContext } from './context.ts';
import { parseAuditResult } from './results.ts';
import { auditOfRun, failAuditRun, finishRun, insertRun, launchRun, modelFor, requireHealthy } from './runs.ts';
import { knowledgeFor } from '../knowledge/service.ts';

const log = childLog('security');

const OPEN: SecurityAuditStatus[] = ['running', 'waiting'];
const MAX_KNOWN = 80;
const MAX_DISMISSED = 40;

/** What the auditor looks at in each area (the prompt's Focus section). */
export const AREA_GUIDES: Record<SecurityArea, string> = {
  access_control:
    'Who can call each route, action, job or command, and what stops everyone else: missing or bypassable checks, one user reaching another user’s data by changing an id (IDOR), admin-only paths, privilege escalation, session and token handling (expiry, storage, rotation, logout), password reset and sign-up flows.',
  injection:
    'Untrusted input reaching a sink: SQL or NoSQL built from strings, shell commands (a shell, or string arguments), file paths (path traversal, zip slip), templates, deserialization, regular expressions a user controls (ReDoS), outgoing requests to user-given URLs (SSRF), prototype pollution, XML entities. Trace each one from the entry point to the sink.',
  web:
    'Browser-facing risks: XSS (raw HTML, markdown rendering, user URLs in href/src), CSRF on state-changing requests, CORS, cookie flags (HttpOnly, Secure, SameSite), security headers (CSP, frame options), open redirects, postMessage handlers, and what the server trusts from the client.',
  secrets:
    'Credentials in the code, config, tests, scripts, CI files, Dockerfiles or logs; secrets that end up in the client bundle (public env vars); default or weak credentials; secrets stored in plain text where they should be encrypted or hashed.',
  data:
    'Sensitive data: personal data, tokens or keys written to logs; error messages that leak internals (stack traces, SQL, paths); API responses with more fields than the client needs; sensitive fields stored unencrypted; data kept or shared longer or wider than needed.',
  crypto:
    'Cryptography: password hashing (MD5, SHA-1, unsalted, fast hashes), Math.random or the like for tokens and ids, hard-coded keys or IVs, disabled TLS verification, home-made crypto, JWT pitfalls (alg none, unverified signatures, weak secrets, no expiry).',
  dependencies:
    'How dependencies come in (known CVEs are checked separately by the dependency scan, so skip those): unpinned or wildcard versions, install scripts, packages from git URLs or unusual registries, abandoned packages in security-critical roles, vendored code, CI actions not pinned, lockfiles missing or out of sync.',
  infrastructure:
    'Configuration and deployment: debug modes and verbose errors in production, Dockerfiles (running as root, secrets in layers), servers listening on 0.0.0.0 without need, exposed admin ports, CI workflows with injectable inputs (pull_request_target, untrusted ${{ }} in run steps), infrastructure-as-code, file permissions.',
  ai:
    'Features that call language models or run agents: prompt injection from untrusted content (web pages, files, user messages) reaching tools or privileged actions, model output used as code, SQL, shell or HTML without checks, provider keys reaching the client, no limits on cost or tool use, sensitive data sent to model providers.',
  abuse:
    'Abuse and availability: no rate limits on login, sign-up, password reset or expensive endpoints; unbounded uploads, queries, pagination or loops a user can trigger; race conditions in money, quota or invite flows; business-logic flaws (skipping steps, negative amounts, replays).',
};

/** What an audit looks up in the knowledge graph besides its brief and areas. */
const AUDIT_FOCUS_WORDS = 'security auth authentication authorization permission role access login session password token secret key privacy personal data compliance gdpr encryption payment admin';

export const SCOPE_LABELS: Record<SecurityAuditScope, string> = {
  full: 'Full project',
  changes: 'Changes since the last audit',
  paths: 'Selected paths',
};

function getAuditOrThrow(ctx: EngineContext, id: string): SecurityAuditRow {
  const a = ctx.db.select().from(securityAudits).where(eq(securityAudits.id, id)).get();
  if (!a) throw new AppError('NOT_FOUND', `audit ${id} not found`, 404);
  return a;
}

/** What the board already knows, so the agent re-checks earlier audit findings and repeats nothing. */
function knownFindingsText(ctx: EngineContext, boardId: string): { toCheck: string; fromScans: string; dismissed: string } {
  const rows = ctx.db
    .select({ f: securityFindings, taskNumber: tasks.number, taskStage: tasks.stage })
    .from(securityFindings)
    .leftJoin(tasks, eq(tasks.id, securityFindings.taskId))
    .where(and(eq(securityFindings.boardId, boardId), inArray(securityFindings.status, ['open', 'added', 'dismissed'])))
    .all()
    .sort((a, b) => SECURITY_SEVERITY_RANK[a.f.severity] - SECURITY_SEVERITY_RANK[b.f.severity] || a.f.number - b.f.number);
  const line = (r: (typeof rows)[number]) => {
    const f = r.f;
    const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : '';
    const task = r.taskNumber ? `, on the board as #${r.taskNumber} (${r.taskStage?.replace('_', ' ')})` : '';
    return `- ${findingRef(f.number)} [${f.severity}]${where}: ${f.title}${task}`;
  };
  const clip = (list: string[], cap: number) => (list.length > cap ? [...list.slice(0, cap), `- … and ${list.length - cap} more`] : list);
  const audit = rows.filter((r) => r.f.source === 'audit' && r.f.status !== 'dismissed').map(line);
  const scans = rows.filter((r) => r.f.source !== 'audit' && r.f.status !== 'dismissed').map(line);
  const dismissed = rows
    .filter((r) => r.f.status === 'dismissed')
    .map((r) => `${line(r)} (${r.f.dismissReason ? SECURITY_DISMISS_LABELS[r.f.dismissReason].toLowerCase() : 'dismissed'}${r.f.dismissNote ? `: ${r.f.dismissNote}` : ''})`);
  return {
    toCheck: audit.length ? clip(audit, MAX_KNOWN).join('\n') : '',
    fromScans: scans.length ? clip(scans, MAX_KNOWN).join('\n') : '',
    dismissed: dismissed.length ? clip(dismissed, MAX_DISMISSED).join('\n') : '',
  };
}

function auditPrompt(ctx: EngineContext, audit: Pick<SecurityAuditRow, 'boardId' | 'scope' | 'focus' | 'paths' | 'instructions' | 'baseSha' | 'headSha'>): string {
  const board = getBoardOrThrow(ctx, audit.boardId);
  const areas = audit.focus.length ? audit.focus : [...SECURITY_AREAS];
  const known = knownFindingsText(ctx, board.id);
  return ctx.prompts.render('security-audit', {
    projectPath: board.projectPath,
    baseBranch: board.baseBranch,
    headSha: audit.headSha ?? 'HEAD',
    scopeFull: audit.scope === 'full',
    scopeChanges: audit.scope === 'changes',
    scopePaths: audit.scope === 'paths',
    baseSha: audit.baseSha,
    paths: audit.paths,
    allAreas: audit.focus.length === 0,
    focus: areas.map((a) => ({ label: SECURITY_CATEGORY_INFO[a].label, guide: AREA_GUIDES[a] })),
    securityBrief: board.securityBrief.trim() || '(none: work out from the code who uses it and what it protects)',
    boardBrief: board.brief.trim() || '(empty)',
    knownToCheck: known.toCheck,
    knownFromScans: known.fromScans,
    knownDismissed: known.dismissed,
    instructions: audit.instructions.trim(),
    knowledge: knowledgeFor(
      ctx,
      board,
      {
        text: [AUDIT_FOCUS_WORDS, board.securityBrief, audit.instructions, ...areas.map((a) => SECURITY_CATEGORY_INFO[a].label)].join('\n'),
        paths: audit.paths,
      },
      'audit',
    ),
  });
}

export function listAudits(ctx: EngineContext, boardId: string) {
  return ctx.db.select().from(securityAudits).where(eq(securityAudits.boardId, boardId)).orderBy(desc(securityAudits.number)).all();
}

/** Starts an audit; one at a time per board. */
export async function startAudit(ctx: EngineContext, boardId: string, body: StartAuditBody): Promise<SecurityAuditRow> {
  requireHealthy(ctx);
  const board = getBoardOrThrow(ctx, boardId);
  const busy = ctx.db
    .select({ number: securityAudits.number })
    .from(securityAudits)
    .where(and(eq(securityAudits.boardId, boardId), inArray(securityAudits.status, OPEN)))
    .get();
  if (busy) throw new AppError('ILLEGAL_TRANSITION', `Audit #${busy.number} is still running.`, 409);
  const headSha = await git.headSha(board.projectPath);
  let baseSha: string | null = null;
  if (body.scope === 'changes') {
    const last = ctx.db
      .select()
      .from(securityAudits)
      .where(and(eq(securityAudits.boardId, boardId), eq(securityAudits.status, 'done')))
      .orderBy(desc(securityAudits.number))
      .all()
      .find((a) => a.headSha);
    if (!last) throw new AppError('ILLEGAL_TRANSITION', 'There is no finished audit to compare with yet. Run a full audit first.', 409);
    baseSha = last.headSha!;
    if (!(await git.refExists(board.projectPath, baseSha))) {
      throw new AppError('ILLEGAL_TRANSITION', `The commit audit #${last.number} read (${baseSha.slice(0, 8)}) is no longer in the repository. Run a full audit.`, 409);
    }
    if (baseSha === headSha) throw new AppError('ILLEGAL_TRANSITION', `Nothing was committed since audit #${last.number}.`, 409);
  }
  const { provider, model } = modelFor(board, null, 'security', body.model ?? null);
  const spec = { boardId, scope: body.scope, focus: body.focus, paths: body.scope === 'paths' ? body.paths : [], instructions: body.instructions, baseSha, headSha };
  const promptText = auditPrompt(ctx, spec);
  const now = nowIso();
  let audit!: SecurityAuditRow;
  ctx.db.transaction((tx) => {
    const top = tx.select({ n: max(securityAudits.number) }).from(securityAudits).where(eq(securityAudits.boardId, boardId)).get();
    const number = (top?.n ?? 0) + 1;
    const marker = securityMarker(board.short, number);
    const runId = insertRun(tx, {
      boardId,
      kind: 'security',
      threadRole: 'security',
      promptText,
      marker,
      launch: { project: board.projectPath, title: `Security audit #${number}: ${SCOPE_LABELS[body.scope]} ${marker}`, provider, model },
    }).id;
    audit = {
      id: newId(),
      ...spec,
      number,
      status: 'running',
      threadId: null,
      threadLink: null,
      runId,
      correctionSent: false,
      summary: null,
      attackSurface: null,
      coverage: [],
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    tx.insert(securityAudits).values(audit).run();
  });
  emitSecurityAudit(ctx, audit.id);
  await launchRun(ctx, audit.runId!);
  // The reconciler may be on its idle interval: have it switch to the active one now.
  ctx.kick();
  return getAuditOrThrow(ctx, audit.id);
}

export const auditViewById = (ctx: EngineContext, id: string) => auditView(ctx.db, getAuditOrThrow(ctx, id));

// ---------------------------------------------------------------------------
// Run lifecycle (called by the reconciler)
// ---------------------------------------------------------------------------

/** `waiting` while the agent waits for the user in T3 (it was told not to ask, but may). */
export function securityAttention(ctx: EngineContext, run: RunRow, waiting: boolean): void {
  const audit = auditOfRun(ctx, run.id);
  if (!audit || !OPEN.includes(audit.status)) return;
  const status: SecurityAuditStatus = waiting ? 'waiting' : 'running';
  if (audit.status === status) return;
  ctx.db.update(securityAudits).set({ status, updatedAt: nowIso() }).where(eq(securityAudits.id, audit.id)).run();
  emitSecurityAudit(ctx, audit.id);
}

/**
 * Records the audit's result block. An unusable block gets one correction message in the same
 * thread (like Ideas); a second one fails the audit.
 */
export async function finalizeAudit(
  ctx: EngineContext,
  run: RunRow,
  o: { texts: string[]; runStatus: RunStatus; threadStatus: string; threadId: string; latestRunId: string | null },
): Promise<void> {
  const audit = auditOfRun(ctx, run.id);
  if (!audit || !OPEN.includes(audit.status)) return finishRun(ctx.db, run.id, { status: o.runStatus });
  const fail = (error: string, resultRaw: string | null = null) =>
    failAuditRun(ctx, run, (tx) => finishRun(tx, run.id, { status: o.runStatus, resultRaw, error }), error);

  if (o.runStatus !== 'completed') return fail(`The agent's run ended ${o.threadStatus.replace('_', ' ')}.`);

  const parsed = parseAuditResult(o.texts);
  if (parsed.ok) {
    const r = parsed.value;
    const now = nowIso();
    ctx.db.transaction((tx) => {
      finishRun(tx, run.id, { status: 'completed', resultRaw: parsed.raw, resultJson: r });
      recordAudit(tx, audit, r.findings, r.resolved);
      tx.update(securityAudits)
        .set({ status: 'done', summary: r.summary.trim(), attackSurface: r.attackSurface.trim() || null, coverage: r.coverage, error: null, finishedAt: now, updatedAt: now })
        .where(eq(securityAudits.id, audit.id))
        .run();
    });
    emitSecurityAudit(ctx, audit.id);
    emitBoard(ctx, audit.boardId);
    log.info({ auditId: audit.id, findings: r.findings.length, resolved: r.resolved.length }, 'security audit finished');
    // A finished audit has nothing more to say: take its thread out of T3's active sidebar.
    if (ctx.settings.get().settleDoneThreads) {
      void ctx.t3.settleThreads([o.threadId]).catch((err) => log.warn({ auditId: audit.id, err: errorMessage(err) }, 'could not settle the audit thread'));
    }
    return;
  }

  const errors = parsed.errors.join('; ');
  if (audit.correctionSent) return fail(`The audit's result was still unusable after one correction: ${errors}`, parsed.raw);

  let correctionRunId = '';
  ctx.db.transaction((tx) => {
    finishRun(tx, run.id, { status: 'completed', resultRaw: parsed.raw, error: errors });
    correctionRunId = insertRun(tx, {
      boardId: audit.boardId,
      kind: 'security',
      threadRole: 'security',
      promptText: ctx.prompts.render('security-audit-correction', { errors }),
      threadId: o.threadId,
      threadLink: audit.threadLink,
      baselineRunId: o.latestRunId,
    }).id;
    tx.update(securityAudits).set({ runId: correctionRunId, correctionSent: true, updatedAt: nowIso() }).where(eq(securityAudits.id, audit.id)).run();
  });
  log.info({ auditId: audit.id, errors }, 'audit result unusable; sent a correction');
  await launchRun(ctx, correctionRunId);
}
