// Security overview: open findings by severity, the worst ones, where each check stands, and the
// board's security settings (the context audits read, review checks, automatic scans).
import {
  findingRef,
  SECURITY_SEVERITY_RANK,
  type BoardSecurityView,
  type BoardView,
  type SecurityFindingView,
  type SecurityScanKind,
  type SecuritySeverity,
} from '@t3-orchestra/shared';
import { ChevronRight, KeyRound, Package, Pencil, ScanSearch, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { usePatchBoard } from '@/api/boards';
import { useBoardContext } from '@/components/board/BoardContext';
import { Markdown } from '@/components/Markdown';
import { SwitchRow } from '@/components/fields';
import { Card } from '@/components/overview/parts';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { SEVERITY_STYLE as REVIEW_SEVERITY_STYLE, stageLabel } from '@/lib/stage';
import { absoluteTime, relativeTime } from '@/lib/time';
import { cn, pluralize } from '@/lib/utils';
import { AuditStatus } from './AuditsPanel';
import { SeverityBadge } from './FindingCard';
import { findingLocation, isAuditOpen, latestScan, SEVERITY_STYLE, type SecuritySection } from './model';

const TILES: SecuritySeverity[] = ['critical', 'high', 'medium', 'low'];

function SeverityTiles({ findings, onSelect }: { findings: SecurityFindingView[]; onSelect: (s: SecuritySection) => void }) {
  const open = (s: SecuritySeverity) => findings.filter((f) => f.status === 'open' && f.severity === s).length;
  const added = findings.filter((f) => f.status === 'added').length;
  const tile = 'flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none';
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {TILES.map((s) => {
        const n = open(s);
        return (
          <button key={s} type="button" className={tile} onClick={() => onSelect('findings')}>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn('size-2 rounded-full', SEVERITY_STYLE[s].dot)} />
              {SEVERITY_STYLE[s].label}
            </span>
            <span className={cn('text-[22px] leading-7 font-semibold tracking-tight tabular', n > 0 && (s === 'critical' || s === 'high') && SEVERITY_STYLE[s].text)}>{n}</span>
            <span className="text-xs text-muted-foreground">open</span>
          </button>
        );
      })}
      <button type="button" className={cn(tile, 'col-span-2 sm:col-span-1')} onClick={() => onSelect('findings')}>
        <span className="text-xs text-muted-foreground">Being fixed</span>
        <span className="text-[22px] leading-7 font-semibold tracking-tight tabular">{added}</span>
        <span className="text-xs text-muted-foreground">on the board</span>
      </button>
    </div>
  );
}

function TopRisks({ findings, onOpen, onSelect }: { findings: SecurityFindingView[]; onOpen: (f: SecurityFindingView) => void; onSelect: (s: SecuritySection) => void }) {
  const open = findings.filter((f) => f.status === 'open').sort((a, b) => SECURITY_SEVERITY_RANK[a.severity] - SECURITY_SEVERITY_RANK[b.severity] || b.number - a.number);
  return (
    <Card
      title="Top risks"
      subtitle={open.length ? `${pluralize(open.length, 'open finding')}, worst first` : undefined}
      actions={
        open.length > 6 ? (
          <Button variant="ghost" size="xs" onClick={() => onSelect('findings')}>
            All findings
            <ChevronRight />
          </Button>
        ) : undefined
      }
    >
      {open.length === 0 ? (
        <div className="flex items-start gap-2.5 py-1 text-[12.5px] text-muted-foreground">
          <ShieldCheck className="mt-px size-4 shrink-0 text-success" />
          <span>{findings.length ? 'Nothing open: every finding is on the board, fixed or dismissed.' : 'No findings yet. Run an audit and the scans to see where the project stands.'}</span>
        </div>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {open.slice(0, 6).map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onOpen(f)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <SeverityBadge severity={f.severity} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{f.title}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {findingRef(f.number)}
                    {findingLocation(f) && ` · ${findingLocation(f)}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CheckRow({ icon, title, status, action }: { icon: ReactNode; title: string; status: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex items-start gap-3 border-t border-border py-2.5 first:border-t-0 first:pt-0 last:pb-0">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium">{title}</p>
        <div className="text-[12px] text-muted-foreground">{status}</div>
      </div>
      {action}
    </li>
  );
}

function Checks({
  data,
  onSelect,
  onNewAudit,
  onAuditChanges,
  onScan,
  scanning,
}: {
  data: BoardSecurityView;
  onSelect: (s: SecuritySection) => void;
  onNewAudit: () => void;
  onAuditChanges: () => void;
  onScan: (kind: SecurityScanKind) => void;
  scanning: SecurityScanKind | null;
}) {
  const audit = data.audits[0];
  const lastDone = data.audits.find((a) => a.status === 'done');
  const auditOpen = isAuditOpen(audit);
  const scanStatus = (kind: SecurityScanKind) => {
    const s = latestScan(data.scans, kind);
    if (!s) return 'Never run.';
    if (s.status === 'running') return 'Running…';
    if (s.status === 'failed') return <span className="text-destructive">Failed {relativeTime(s.finishedAt)}.</span>;
    const open = data.findings.filter((f) => f.source === kind && (f.status === 'open' || f.status === 'added')).length;
    return (
      <span title={absoluteTime(s.finishedAt)}>
        {relativeTime(s.finishedAt)} · {open ? pluralize(open, 'finding') + ' unresolved' : 'nothing unresolved'}
      </span>
    );
  };
  const scanButton = (kind: SecurityScanKind) => {
    const running = latestScan(data.scans, kind)?.status === 'running' || scanning === kind;
    return (
      <Button variant="secondary" size="xs" onClick={() => onScan(kind)} disabled={running}>
        {running && <Spinner className="size-3" />}
        {running ? 'Scanning' : 'Scan'}
      </Button>
    );
  };
  return (
    <Card title="Checks" subtitle="Where each check stands">
      <ul className="flex flex-col">
        <CheckRow
          icon={<ScanSearch className="size-4" />}
          title="Audit"
          status={
            auditOpen ? (
              `#${audit!.number} running…`
            ) : lastDone ? (
              <>
                <button type="button" className="hover:text-foreground hover:underline" onClick={() => onSelect('audits')}>
                  #{lastDone.number}
                </button>{' '}
                <span title={absoluteTime(lastDone.finishedAt)}>{relativeTime(lastDone.finishedAt)}</span>
                {data.commitsSinceAudit !== null && ` · ${data.commitsSinceAudit ? pluralize(data.commitsSinceAudit, 'commit') + ' since' : 'up to date'}`}
              </>
            ) : (
              'No audit yet.'
            )
          }
          action={
            auditOpen ? (
              <Spinner className="mt-1 size-3.5" />
            ) : lastDone && (data.commitsSinceAudit ?? 0) > 0 ? (
              <Button variant="secondary" size="xs" onClick={onAuditChanges}>
                Audit changes
              </Button>
            ) : (
              <Button variant="secondary" size="xs" onClick={onNewAudit}>
                {lastDone ? 'Audit again' : 'Audit'}
              </Button>
            )
          }
        />
        <CheckRow icon={<KeyRound className="size-4" />} title="Secret scan" status={scanStatus('secrets')} action={scanButton('secrets')} />
        <CheckRow icon={<Package className="size-4" />} title="Dependency scan" status={scanStatus('dependencies')} action={scanButton('dependencies')} />
      </ul>
    </Card>
  );
}

function SettingsCard({ board }: { board: BoardView }) {
  const patch = usePatchBoard();
  const [draft, setDraft] = useState<string | null>(null);
  const brief = board.securityBrief.trim();
  const save = (text: string) => patch.mutate({ board, patch: { securityBrief: text.trim() } }, { onSuccess: () => setDraft(null) });
  return (
    <Card title="Security settings" subtitle="What audits and reviews should know, and what runs on its own">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 text-[12.5px] font-medium">Security context</h3>
          {draft === null && (
            <Button variant="ghost" size="xs" onClick={() => setDraft(board.securityBrief)}>
              <Pencil />
              {brief ? 'Edit' : 'Write it'}
            </Button>
          )}
        </div>
        {draft !== null ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save(draft);
            }}
          >
            <Textarea
              autoFocus
              rows={5}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Security context"
              placeholder={'Who uses it (public internet, logged-in customers, one team behind a VPN).\nWhat it protects (payments, personal data, nothing sensitive).\nHow it is deployed, and what is out of scope.'}
            />
            <div className="flex justify-end gap-1.5">
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={patch.isPending}>
                Save
              </Button>
            </div>
          </form>
        ) : brief ? (
          <Markdown className="text-[12.5px]">{brief}</Markdown>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">
            Who uses the app, what it protects and how it runs. Audits read it to tell a real risk from a theoretical one; without it they work it out
            from the code.
          </p>
        )}
      </div>
      <div className="-mb-2.5 border-t border-border">
        <SwitchRow
          label="Security checks in AI reviews"
          hint="Every task's reviewer also reads the change as an attacker would, and flags issues as Security findings."
          checked={board.securityReview}
          onCheckedChange={(v) => patch.mutate({ board, patch: { securityReview: v } })}
        />
        <SwitchRow
          label="Scan automatically"
          hint="Runs the secret and dependency scans again when the root checkout moves to a new commit, and at least daily."
          checked={board.securityAutoScan}
          onCheckedChange={(v) => patch.mutate({ board, patch: { securityAutoScan: v } })}
        />
      </div>
    </Card>
  );
}

function ReviewFlags({ data, board }: { data: BoardSecurityView; board: BoardView }) {
  const { tasks, openTask } = useBoardContext();
  const flags = data.reviewFlags;
  return (
    <Card title="Flagged in AI reviews" subtitle={flags.length ? 'Security issues reviewers raised on tasks' : undefined}>
      {flags.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          {board.securityReview
            ? 'No reviewer has flagged a security issue yet.'
            : 'Turn on security checks in AI reviews, and issues reviewers find in each task show up here.'}
        </p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {flags.slice(0, 8).map((r) => {
            const task = tasks.find((t) => t.id === r.taskId);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  disabled={!task}
                  onClick={() => task && openTask(task, 'review')}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:hover:bg-transparent"
                >
                  <span className={cn('rounded-[5px] border px-1.5 text-2xs leading-5 font-medium', REVIEW_SEVERITY_STYLE[r.severity])}>{r.severity}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{r.title.replace(/^security:\s*/i, '')}</span>
                  <Tip content={`${r.taskTitle} · ${stageLabel(r.taskStage)}`}>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{r.taskNumber}</span>
                  </Tip>
                  {r.status !== 'open' && <span className="shrink-0 text-[11px] text-muted-foreground">{r.status}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function OverviewPanel({
  data,
  onSelect,
  onOpenFinding,
  onNewAudit,
  onAuditChanges,
  onRetryAudit,
  onScan,
  scanning,
}: {
  data: BoardSecurityView;
  onSelect: (s: SecuritySection) => void;
  onOpenFinding: (f: SecurityFindingView) => void;
  onNewAudit: () => void;
  onAuditChanges: () => void;
  onRetryAudit: () => void;
  onScan: (kind: SecurityScanKind) => void;
  scanning: SecurityScanKind | null;
}) {
  const { board } = useBoardContext();
  const latest = data.audits[0];
  const neverChecked = data.audits.length === 0 && data.scans.length === 0;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-4 sm:px-5">
      {neverChecked && (
        <div className="flex flex-col gap-3 rounded-lg border border-primary/25 bg-primary/6 p-4 sm:flex-row sm:items-center">
          <TriangleAlert className="size-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">Nothing has been checked yet</p>
            <p className="text-[12.5px] text-muted-foreground">
              Start with the two scans (a few seconds, no agent), then an audit, where an agent reads the code for what an attacker could do.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => onScan('secrets')}>
              Scan for secrets
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onScan('dependencies')}>
              Check dependencies
            </Button>
            <Button size="sm" onClick={onNewAudit}>
              <ScanSearch />
              Start an audit
            </Button>
          </div>
        </div>
      )}
      {/* Running, waiting for you, or failed: the newest audit is the one that matters. */}
      {latest && latest.status !== 'done' && <AuditStatus audit={latest} onRetry={onRetryAudit} />}
      <SeverityTiles findings={data.findings} onSelect={onSelect} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <TopRisks findings={data.findings} onOpen={onOpenFinding} onSelect={onSelect} />
        <Checks data={data} onSelect={onSelect} onNewAudit={onNewAudit} onAuditChanges={onAuditChanges} onScan={onScan} scanning={scanning} />
      </div>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <SettingsCard board={board} />
        <ReviewFlags data={data} board={board} />
      </div>
    </div>
  );
}
