// Board reports for the MCP endpoint: what a board is working on and how far along it is, as markdown for
// agents and as an HTML card for T3 Code's html_render.
import {
  boardOverview,
  COLUMN_LABELS,
  COLUMN_ORDER,
  columnFor,
  holdReason,
  SEVERITIES,
  STAGE_REASON_LABELS,
  type BoardOverview,
  type BoardView,
  type FindingCounts,
  type HoldReason,
  type MilestoneView,
  type OverviewColumn,
  type RunKind,
  type TaskDetailView,
  type TaskView,
} from '@t3-orchestra/shared';
import { boardTaskViews, milestoneView, taskDetailView } from '../db/views.ts';
import { listBoards } from '../engine/boards.ts';
import { AppError, viewCtx, type EngineContext } from '../engine/context.ts';
import { listMilestones } from '../engine/milestones.ts';

const AGENT_READ_TIMEOUT_MS = 5000;

export interface BoardReport {
  board: BoardView;
  /** Every task but the discarded ones. */
  tasks: TaskView[];
  overview: BoardOverview;
  milestones: MilestoneView[];
  pauseAll: boolean;
  t3Reachable: boolean;
  /** The board in the web app. */
  url: string;
  /** Latest agent message per task id, for tasks with a live agent (running, AI review, Needs Input). */
  agentNotes: Map<string, string>;
  now: number;
}

/** A board by id, slug or name (or a unique part of it); with no ref, the only board there is. */
export function resolveBoard(ctx: EngineContext, ref: string | undefined): BoardView {
  const boards = listBoards(ctx);
  const names = boards.map((b) => b.name).join(', ');
  const q = ref?.trim().toLowerCase();
  if (!q) {
    if (boards.length === 1) return boards[0]!;
    if (boards.length === 0) throw new AppError('NOT_FOUND', 'There are no boards yet.', 404);
    throw new AppError('VALIDATION', `Say which board: ${names}.`);
  }
  const exact = boards.find((b) => b.id === ref!.trim() || b.slug === q || b.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = boards.filter((b) => b.name.toLowerCase().includes(q) || b.slug.includes(q));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) throw new AppError('VALIDATION', `"${ref}" matches ${partial.map((b) => b.name).join(', ')}. Say which.`);
  throw new AppError('NOT_FOUND', `No board "${ref}". Boards: ${names || 'none'}.`, 404);
}

/** The agent's latest message on a thread, or null when there is none or T3 doesn't answer in time. */
async function latestAgentMessage(ctx: EngineContext, threadId: string): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), AGENT_READ_TIMEOUT_MS);
    });
    const { messages } = await Promise.race([ctx.t3.show(threadId, { messages: 6 }), timeout]);
    const text = messages.filter((m) => m.role === 'assistant' && m.text.trim()).at(-1)?.text ?? '';
    // The result block is for the board; the prose around it says what happened.
    const prose = text.replace(/```(?:t3orchestra|yardmaster|t3board)-result[\s\S]*?(```|$)/g, '').trim();
    return prose || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const liveThread = (t: TaskView) => t.activeRun?.threadId ?? t.threadId;

export async function boardReport(ctx: EngineContext, ref: string | undefined, o: { agentNotes: boolean }): Promise<BoardReport> {
  const board = resolveBoard(ctx, ref);
  const tasks = boardTaskViews(ctx.db, board.id, viewCtx(ctx));
  const pauseAll = ctx.settings.get().pauseAll;
  const now = Date.now();
  const overview = boardOverview(tasks, { board, pauseAll, now });
  const agentNotes = new Map<string, string>();
  if (o.agentNotes) {
    const live = [...overview.running, ...tasks.filter((t) => t.attention !== null)].slice(0, 8);
    await Promise.all(
      live.map(async (t) => {
        const threadId = liveThread(t);
        const note = threadId ? await latestAgentMessage(ctx, threadId) : null;
        if (note) agentNotes.set(t.id, note);
      }),
    );
  }
  return {
    board,
    tasks,
    overview,
    milestones: listMilestones(ctx.db, board.id).map(milestoneView),
    pauseAll,
    t3Reachable: ctx.health.get().serverReachable,
    url: `${ctx.config.publicUrl}/b/${board.slug}`,
    agentNotes,
    now,
  };
}

// ---- wording ---------------------------------------------------------------------

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

function ago(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  return now - t < 45_000 ? 'just now' : `${duration(now - t)} ago`;
}

/** The message on one line, cut to `max` characters. */
function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const RUN_WORK: Record<RunKind, string> = {
  spec: 'drafting a spec',
  plan: 'planning',
  implement: 'implementing',
  fix: 'fixing review findings',
  changes: 'making your requested changes',
  resume: 'resuming',
  rebase: 'updating its branch',
  followup: 'answering a follow-up',
  pr: 'opening a PR',
  design: 'building the design you picked',
  options: 'making new design options',
  review: 'AI review',
  insight: 'answering a question',
  ideas: 'generating ideas',
  import: 'learning about the project from T3',
  security: 'auditing security',
  knowledge: 'reading context files into the knowledge graph',
};

const ATTENTION_WORK = { question: 'asks you something', approval: 'waits for your approval', waiting: 'waits for you' };

/** What an active task is doing: "fixing review findings (round 2) · 14m · 22 events". */
function activity(t: TaskView, now: number): string {
  const run = t.activeRun;
  const parts: string[] = [];
  if (run) {
    parts.push(run.round ? `${RUN_WORK[run.kind]} (round ${run.round})` : RUN_WORK[run.kind]);
    const started = Date.parse(run.startedAt);
    if (!Number.isNaN(started)) parts.push(`for ${duration(now - started)}`);
    if (run.events > 0) parts.push(`${run.events} ${run.events === 1 ? 'event' : 'events'}`);
    if (run.background.length) parts.push(`turn ended, waiting on background work: ${run.background.join(', ')}`);
  } else {
    parts.push(COLUMN_LABELS[column(t)]);
  }
  if (t.quietMinutes !== null) parts.push(`quiet for ${duration(t.quietMinutes * 60_000)}`);
  return parts.join(' · ');
}

function column(t: TaskView): OverviewColumn {
  const c = columnFor(t);
  return c === 'hidden' ? 'backlog' : c;
}

export function openFindingsText(f: FindingCounts): string {
  return SEVERITIES.filter((s) => s !== 'nit' && (f.open[s] ?? 0) > 0)
    .map((s) => `${f.open[s]} ${s}`)
    .join(', ');
}

/** Why a task in Needs You is there: "asks you something", "Run failed", "AI passed · review 6/10". */
function needsYouText(t: TaskView): string {
  if (t.attention) return ATTENTION_WORK[t.attention];
  const parts = [t.stageReason ? STAGE_REASON_LABELS[t.stageReason] : COLUMN_LABELS[column(t)]];
  if (t.reviewScore !== null) parts.push(`review ${t.reviewScore}/10`);
  const findings = openFindingsText(t.findings);
  if (findings) parts.push(`${findings} open`);
  return parts.join(' · ');
}

function holdText(h: HoldReason): string {
  const nums = (ns: number[]) => ns.map((n) => `#${n}`).join(' ');
  switch (h.kind) {
    case 'ready':
      return 'starts next';
    case 'no_slot':
      return `waits for a free slot (${h.active}/${h.max} busy)`;
    case 'overlap':
      return `waits for ${nums(h.tasks)} (both touch ${h.paths[0]}${h.paths.length > 1 ? ` +${h.paths.length - 1}` : ''})`;
    case 'waiting':
      return `waits for ${nums(h.deps.map((d) => d.number))}`;
    case 'blocked':
      return `blocked by ${h.deps.map((d) => `#${d.number} (${d.stage})`).join(', ')}`;
    case 'auto_run_off':
      return 'auto-run is off';
    case 'paused':
      return 'paused (all boards)';
    case 'backlog':
      return 'in Backlog';
  }
}

const HOLD_RANK: Record<HoldReason['kind'], number> = {
  ready: 0,
  no_slot: 1,
  overlap: 2,
  waiting: 3,
  blocked: 4,
  auto_run_off: 5,
  paused: 6,
  backlog: 7,
};

/** Backlog and Ready tasks with why they aren't running, the ones closest to starting first. */
function upNext(r: BoardReport): Array<{ task: TaskView; hold: HoldReason }> {
  const active = r.tasks.filter((t) => t.stage === 'implementing' || t.stage === 'ai_review');
  return r.tasks
    .map((task) => ({ task, hold: holdReason(task, r.board, active, r.pauseAll) }))
    .filter((x): x is { task: TaskView; hold: HoldReason } => x.hold !== null)
    .sort((a, b) => HOLD_RANK[a.hold.kind] - HOLD_RANK[b.hold.kind] || a.task.position - b.task.position);
}

interface MilestoneProgress {
  label: string;
  goal: string;
  total: number;
  done: number;
  active: number;
}

function milestoneProgress(r: BoardReport): MilestoneProgress[] {
  const rows: MilestoneProgress[] = r.milestones.map((m) => {
    const ts = r.tasks.filter((t) => t.milestoneId === m.id);
    return {
      label: `M${m.number} · ${m.title}`,
      goal: m.goal,
      total: ts.length,
      done: ts.filter((t) => t.stage === 'done').length,
      active: ts.filter((t) => t.activeRun !== null).length,
    };
  });
  const loose = r.tasks.filter((t) => !t.milestoneId || !r.milestones.some((m) => m.id === t.milestoneId));
  if (rows.length > 0 && loose.length > 0) {
    rows.push({
      label: 'No milestone',
      goal: '',
      total: loose.length,
      done: loose.filter((t) => t.stage === 'done').length,
      active: loose.filter((t) => t.activeRun !== null).length,
    });
  }
  return rows;
}

function recentlyDone(r: BoardReport, n: number): TaskView[] {
  return r.tasks
    .filter((t) => t.stage === 'done' && t.completedAt)
    .sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!))
    .slice(0, n);
}

function percent(done: number, total: number): number {
  return total ? Math.round((done / total) * 100) : 0;
}

/** "Auto-run on · 1 of 3 slots busy". */
function runState(r: BoardReport): string {
  const busy = r.tasks.filter((t) => t.stage === 'implementing' || t.stage === 'ai_review').length;
  const state = r.pauseAll ? 'Paused (all boards)' : r.board.autoRun ? 'Auto-run on' : 'Auto-run off';
  return `${state} · ${busy} of ${r.board.maxParallel} slots busy`;
}

/** "9.1 done/day over the last 7 days, about 3 days left at that pace". */
function paceText(r: BoardReport): string {
  const { overview: ov } = r;
  const { pace } = ov;
  const days = `${pace.windowDays} ${pace.windowDays === 1 ? 'day' : 'days'}`;
  if (ov.remaining === 0 && ov.total > 0) return 'all done';
  if (pace.done === 0) return `nothing finished in the last ${days}`;
  const eta = pace.etaDays === null ? '' : `, about ${pace.etaDays < 1 ? 'less than a day' : `${Math.ceil(pace.etaDays)} days`} left at that pace`;
  return `${pace.perDay.toFixed(1)} done/day over the last ${days}${eta}`;
}

function taskRef(t: Pick<TaskView, 'number' | 'title'>): string {
  return `#${t.number} ${t.title}`;
}

function milestoneOf(r: BoardReport, t: TaskView): string | null {
  const m = r.milestones.find((x) => x.id === t.milestoneId);
  return m ? `M${m.number}` : null;
}

// ---- markdown ----------------------------------------------------------------------

export function boardsMarkdown(boards: BoardView[]): string {
  if (boards.length === 0) return 'There are no boards yet.';
  return boards
    .map((b) => {
      const done = b.counts.byColumn.done ?? 0;
      const parts = [
        `${done} of ${b.counts.total} done`,
        `${b.counts.active} running`,
        `${b.counts.needsYou} need you`,
        b.autoRun ? 'auto-run on' : 'auto-run off',
      ];
      return `- **${b.name}** (\`${b.slug}\`): ${parts.join(' · ')} — ${b.projectPath}`;
    })
    .join('\n');
}

export function statusMarkdown(r: BoardReport, o: { upNext?: number } = {}): string {
  const { board, overview: ov, now } = r;
  const out: string[] = [];
  out.push(`# ${board.name}: ${ov.done} of ${ov.total} tasks done (${percent(ov.done, ov.total)}%)`);
  out.push('');
  out.push(`${runState(r)} · ${paceText(r)}`);
  out.push(
    COLUMN_ORDER.filter((c) => ov.byColumn[c] > 0)
      .map((c) => `${COLUMN_LABELS[c]} ${ov.byColumn[c]}`)
      .join(' · ') || 'No tasks yet.',
  );
  out.push(`Board: ${r.url}/overview`);
  if (!r.t3Reachable) out.push('**T3 Code is not reachable**, so nothing starts and agent messages are missing.');

  out.push('', `## Working on now (${ov.running.length})`);
  if (ov.running.length === 0) out.push('Nothing is running.');
  for (const t of ov.running) {
    const ms = milestoneOf(r, t);
    out.push(`- **${taskRef(t)}**${ms ? ` (${ms})` : ''}: ${activity(t, now)}`);
    const note = r.agentNotes.get(t.id);
    if (note) out.push(`  Latest from the agent: "${oneLine(note, 400)}"`);
    const link = t.activeRun?.threadLink ?? t.threadLink;
    if (link) out.push(`  Thread: ${link}`);
  }

  out.push('', `## Needs you (${ov.needsYou.length})`);
  if (ov.needsYou.length === 0) out.push('Nothing.');
  for (const t of ov.needsYou) {
    out.push(`- **${taskRef(t)}** [${COLUMN_LABELS[column(t)]}]: ${needsYouText(t)}`);
    const said = r.agentNotes.get(t.id) ?? (t.stage === 'failed' ? t.lastMessage : null);
    if (said) out.push(`  ${t.attention ? 'The agent says' : 'Last message'}: "${oneLine(said, 400)}"`);
  }

  const next = upNext(r);
  const max = o.upNext ?? 8;
  out.push('', `## Up next (${ov.byColumn.ready} Ready, ${ov.byColumn.backlog} in Backlog)`);
  if (next.length === 0) out.push('Nothing left to start.');
  for (const { task, hold } of next.slice(0, max)) out.push(`- ${taskRef(task)}: ${holdText(hold)}`);
  if (next.length > max) out.push(`- …and ${next.length - max} more`);

  const ms = milestoneProgress(r);
  if (ms.length > 0) {
    out.push('', '## Milestones');
    for (const m of ms) {
      const state = m.total > 0 && m.done === m.total ? `all ${m.total} done` : `${m.done} of ${m.total} done${m.active ? `, ${m.active} in progress` : ''}`;
      out.push(`- ${m.label}: ${state}`);
    }
  }

  const done = recentlyDone(r, 5);
  if (done.length > 0) {
    out.push('', '## Recently done');
    for (const t of done) {
      out.push(`- ${taskRef(t)} (${ago(t.completedAt, now)}${t.stageReason === 'auto_approved' ? ', auto-approved' : ''})`);
    }
  }
  return out.join('\n');
}

/** One task by number (`54` or `#54`) on a board, discarded ones included. */
export function findTask(ctx: EngineContext, board: BoardView, ref: number | string): TaskDetailView {
  const n = typeof ref === 'number' ? ref : Number(String(ref).replace(/^\s*#/, ''));
  const task = boardTaskViews(ctx.db, board.id, { ...viewCtx(ctx), includeDiscarded: true }).find((t) => t.number === n);
  const detail = task && taskDetailView(ctx.db, task.id, viewCtx(ctx), () => []);
  if (!detail) throw new AppError('NOT_FOUND', `${board.name} has no task #${ref}.`, 404);
  return detail;
}

export async function taskMarkdown(ctx: EngineContext, board: BoardView, t: TaskDetailView): Promise<string> {
  const now = Date.now();
  const threadId = liveThread(t);
  const latest = threadId ? await latestAgentMessage(ctx, threadId) : null;
  const ms = listMilestones(ctx.db, board.id).find((m) => m.id === t.milestoneId);
  const where = t.stage === 'discarded' ? 'Discarded' : COLUMN_LABELS[column(t)];
  const state = t.activeRun ? activity(t, now) : t.stageReason ? STAGE_REASON_LABELS[t.stageReason] : null;

  const out: string[] = [`# #${t.number} ${t.title}`, ''];
  out.push(
    [
      `Board ${board.name}`,
      state ? `${where}: ${state}` : where,
      ms ? `M${ms.number} · ${ms.title}` : null,
      `${t.priority} priority`,
      `${t.complexity} ${t.category}`,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  const link = t.activeRun?.threadLink ?? t.threadLink;
  if (link) out.push(`Thread: ${link}`);
  if (t.branch) out.push(`Branch: ${t.branch}${t.worktreePath ? ` (worktree ${t.worktreePath})` : ''}`);
  if (t.prUrl) out.push(`PR: ${t.prUrl}`);
  if (t.deps.length) out.push(`Depends on: ${t.deps.map((d) => `#${d.number} (${d.stage})`).join(', ')}`);
  if (t.diffStat) out.push(`Diff: +${t.diffStat.added} −${t.diffStat.removed} in ${t.diffStat.files} files`);
  const findings = openFindingsText(t.findings);
  if (findings) out.push(`Open review findings: ${findings}`);
  if (t.reviewScore !== null) out.push(`AI review score (how much it needs you): ${t.reviewScore}/10${t.reviewScoreReason ? `, ${t.reviewScoreReason}` : ''}`);
  if (t.startedAt) out.push(`Started ${ago(t.startedAt, now)}${t.completedAt ? `, finished ${ago(t.completedAt, now)}` : ''}`);

  if (t.description.trim()) out.push('', '## Description', t.description.trim());
  if (t.acceptanceCriteria.length) out.push('', '## Acceptance criteria', ...t.acceptanceCriteria.map((a) => `- ${a}`));
  if (latest) out.push('', '## Latest from the agent', latest.length > 2000 ? `${latest.slice(0, 1999)}…` : latest);
  else if (t.lastMessage) out.push('', '## Last agent message', t.lastMessage.length > 2000 ? `${t.lastMessage.slice(0, 1999)}…` : t.lastMessage);
  if (t.lastSummary) out.push('', '## Last summary', t.lastSummary);

  const open = t.findingsList.filter((f) => f.status === 'open');
  if (open.length) {
    out.push('', '## Open findings');
    for (const f of open) out.push(`- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`);
  }
  if (t.runs.length) {
    out.push('', '## Runs');
    for (const run of t.runs.slice(-8)) {
      const took = run.finishedAt ? `, took ${duration(Date.parse(run.finishedAt) - Date.parse(run.startedAt))}` : '';
      out.push(`- ${run.kind}${run.round ? ` r${run.round}` : ''}: ${run.status}, started ${ago(run.startedAt, now)}${took}${run.error ? ` (${run.error})` : ''}`);
    }
  }
  if (t.events.length) {
    out.push('', '## Recent events');
    for (const e of t.events.slice(-10)) {
      const p = e.payload as { from?: unknown; to?: unknown; reason?: unknown };
      const move = typeof p.to === 'string' ? ` → ${p.to}${typeof p.reason === 'string' ? ` (${p.reason})` : ''}` : '';
      out.push(`- ${ago(e.createdAt, now)}: ${e.type}${move}`);
    }
  }
  return out.join('\n');
}

// ---- HTML card -------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Bar colours per column: T3 Code's theme variables, with fallbacks for a plain browser. */
const COLUMN_COLOR: Record<OverviewColumn, string> = {
  done: 'var(--success, #22a06b)',
  human_review: 'var(--chart-3, #8b5cf6)',
  ai_review: 'var(--chart-4, #0ea5e9)',
  running: 'var(--info, #3b82f6)',
  needs_input: 'var(--warning, #f59e0b)',
  failed: 'var(--destructive, #ef4444)',
  ready: 'var(--chart-2, #14b8a6)',
  backlog: 'color-mix(in srgb, var(--muted-foreground, #888) 45%, transparent)',
};
const BAR_ORDER: OverviewColumn[] = ['done', 'human_review', 'ai_review', 'running', 'needs_input', 'failed', 'ready', 'backlog'];

const CARD_CSS = `
body { margin: 0; font-family: var(--font-sans, system-ui, sans-serif); color: var(--foreground, #1f1f1f); font-size: 13px; line-height: 1.45; }
.head { display: flex; justify-content: space-between; align-items: baseline; gap: 4px 12px; flex-wrap: wrap; }
.big { font-size: 15px; font-weight: 600; }
.muted { color: var(--muted-foreground, #737373); }
.num { font-family: var(--font-mono, ui-monospace, monospace); color: var(--muted-foreground, #737373); }
.bar { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--secondary, #eee); margin: 10px 0 8px; }
.bar span { display: block; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 2px 14px; font-size: 12px; color: var(--muted-foreground, #737373); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
h3 { font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted-foreground, #737373); margin: 18px 0 2px; font-weight: 600; }
.row { padding: 7px 0; border-top: 1px solid var(--border, #e5e5e5); }
h3 + .row { border-top: 0; }
.title { font-weight: 500; }
.meta { font-size: 12px; color: var(--muted-foreground, #737373); }
.note { font-size: 12px; margin-top: 2px; opacity: .9; }
.tag { font-size: 11px; padding: 0 6px; border-radius: 999px; margin-left: 6px; white-space: nowrap; }
.ms { display: grid; grid-template-columns: minmax(0, 1fr) minmax(60px, 140px) 64px; gap: 10px; align-items: center; padding: 4px 0; }
.ms .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mini { height: 6px; border-radius: 999px; background: var(--secondary, #eee); overflow: hidden; }
.mini span { display: block; height: 100%; background: var(--success, #22a06b); }
.right { text-align: right; font-variant-numeric: tabular-nums; }
.foot { margin-top: 16px; font-size: 12px; }
a { color: var(--primary, #2563eb); }
`;

export function statusHtml(r: BoardReport): string {
  const { board, overview: ov, now } = r;
  const total = Math.max(ov.total, 1);
  const pct = (n: number, of: number) => `${of ? Math.round((n / of) * 1000) / 10 : 0}%`;
  const parts: string[] = [];

  parts.push(
    `<div class="head"><div><span class="big">${ov.done} of ${ov.total} done</span> <span class="muted">· ${percent(ov.done, ov.total)}% · ${esc(board.name)}</span></div>` +
      `<div class="muted">${esc(runState(r))}</div></div>`,
  );
  parts.push(
    `<div class="bar">${BAR_ORDER.filter((c) => ov.byColumn[c] > 0)
      .map((c) => `<span title="${COLUMN_LABELS[c]} ${ov.byColumn[c]}" style="width:${pct(ov.byColumn[c], total)};background:${COLUMN_COLOR[c]}"></span>`)
      .join('')}</div>`,
  );
  parts.push(
    `<div class="legend">${BAR_ORDER.filter((c) => ov.byColumn[c] > 0)
      .map((c) => `<span><span class="dot" style="background:${COLUMN_COLOR[c]}"></span>${COLUMN_LABELS[c]} ${ov.byColumn[c]}</span>`)
      .join('')}</div>`,
  );
  if (!r.t3Reachable) parts.push(`<div class="note" style="color:var(--destructive, #ef4444)">T3 Code is not reachable, so nothing starts.</div>`);

  const taskRow = (t: TaskView, meta: string, note: string | null, tag?: { text: string; color: string }) =>
    `<div class="row"><div><span class="num">#${t.number}</span> <span class="title">${esc(t.title)}</span>` +
    (tag ? `<span class="tag" style="color:${tag.color};background:color-mix(in srgb, ${tag.color} 14%, transparent)">${esc(tag.text)}</span>` : '') +
    `</div><div class="meta">${esc(meta)}</div>${note ? `<div class="note">“${esc(oneLine(note, 220))}”</div>` : ''}</div>`;

  parts.push(`<h3>Working on now · ${ov.running.length}</h3>`);
  if (ov.running.length === 0) parts.push(`<div class="meta">Nothing is running.</div>`);
  for (const t of ov.running) {
    const ms = milestoneOf(r, t);
    parts.push(
      taskRow(t, [activity(t, now), ms].filter(Boolean).join(' · '), r.agentNotes.get(t.id) ?? null, {
        text: COLUMN_LABELS[column(t)],
        color: COLUMN_COLOR[column(t)],
      }),
    );
  }

  if (ov.needsYou.length > 0) {
    parts.push(`<h3>Needs you · ${ov.needsYou.length}</h3>`);
    for (const t of ov.needsYou.slice(0, 6)) {
      parts.push(taskRow(t, needsYouText(t), t.attention ? (r.agentNotes.get(t.id) ?? null) : null, { text: COLUMN_LABELS[column(t)], color: COLUMN_COLOR[column(t)] }));
    }
    if (ov.needsYou.length > 6) parts.push(`<div class="meta">…and ${ov.needsYou.length - 6} more</div>`);
  }

  const next = upNext(r);
  if (next.length > 0) {
    parts.push(`<h3>Up next · ${next.length}</h3>`);
    for (const { task, hold } of next.slice(0, 4)) parts.push(taskRow(task, holdText(hold), null));
    if (next.length > 4) parts.push(`<div class="meta">…and ${next.length - 4} more</div>`);
  }

  const ms = milestoneProgress(r);
  if (ms.length > 0) {
    parts.push(`<h3>Milestones</h3>`);
    for (const m of ms) {
      parts.push(
        `<div class="ms"><div class="label" title="${esc(m.goal)}">${esc(m.label)}</div>` +
          `<div class="mini"><span style="width:${pct(m.done, m.total)}"></span></div>` +
          `<div class="right muted">${m.done}/${m.total}</div></div>`,
      );
    }
  }

  const pace = paceText(r);
  parts.push(`<div class="foot muted">${esc(`${pace[0]!.toUpperCase()}${pace.slice(1)}. `)}<a href="${esc(r.url)}/overview" target="_blank" rel="noopener">Open the board</a></div>`);

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(board.name)}</title><style>${CARD_CSS}</style></head><body>${parts.join('\n')}</body></html>`;
}
