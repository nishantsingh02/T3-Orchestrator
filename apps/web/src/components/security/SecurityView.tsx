// Security: audits by a read-only agent, a local secret scan and a dependency check against OSV.dev,
// and the findings they produce, each of which can go to the board as a task. Sections on the left;
// the section is in the URL (?section=…, plus ?finding=N or ?audit=N) and remembered per board.
import type { SecurityAuditView, SecurityFindingView, SecurityScanKind } from '@t3-orchestra/shared';
import { ChevronDown, Download, MessageCircleQuestion, Play, ScanSearch, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { api, errorMessage } from '@/api/client';
import { useSecurity, useStartAudit, useStartScan } from '@/api/security';
import { useBoardContext } from '@/components/board/BoardContext';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton, Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { readString, writeString } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { AuditDialog, type AuditPreset } from './AuditDialog';
import { AuditsPanel } from './AuditsPanel';
import { FindingsList } from './FindingsList';
import { isAuditOpen, isSecuritySection, latestScan, SECTION_INFO, SECURITY_SECTIONS, type SecuritySection } from './model';
import { OverviewPanel } from './OverviewPanel';
import { ScanPanel } from './ScanPanel';

function RailBadge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'danger' }) {
  return <span className={cn('font-mono text-[11px] tabular', tone === 'danger' ? 'text-destructive' : 'text-muted-foreground')}>{children}</span>;
}

export function SecurityView() {
  const { board } = useBoardContext();
  const [params, setParams] = useSearchParams();
  const q = useSecurity(board.id);
  const startAudit = useStartAudit(board.id);
  const startScan = useStartScan(board.id);
  const [dialog, setDialog] = useState<{ preset?: AuditPreset } | null>(null);

  const storeKey = `securitySection:${board.id}`;
  const fromUrl = params.get('section');
  const stored = readString(storeKey);
  const section: SecuritySection = isSecuritySection(fromUrl) ? fromUrl : isSecuritySection(stored) ? stored : 'overview';
  const findingParam = Number(params.get('finding')) || null;
  const auditParam = Number(params.get('audit')) || null;
  const go = (s: SecuritySection, extra: Record<string, string> = {}) => {
    writeString(storeKey, s);
    setParams({ section: s, ...extra }, { replace: true });
  };

  const data = q.data;
  const findings = data?.findings ?? [];
  const audits = data?.audits ?? [];
  const latestAudit = audits[0];
  const auditRunning = isAuditOpen(latestAudit) || startAudit.isPending;
  const lastDone = audits.find((a) => a.status === 'done');
  const scanning: SecurityScanKind | null = startScan.isPending ? (startScan.variables ?? null) : null;

  const openFinding = (f: SecurityFindingView) =>
    go(f.source === 'audit' ? 'findings' : f.source, { finding: String(f.number) });
  const scan = (kind: SecurityScanKind) => startScan.mutate(kind);
  const onAuditStarted = (a: SecurityAuditView) => go('audits', { audit: String(a.number) });
  const retry = (a: SecurityAuditView) =>
    startAudit.mutate(
      { scope: a.scope === 'changes' ? 'full' : a.scope, focus: a.focus, paths: a.paths, instructions: a.instructions },
      { onSuccess: onAuditStarted, onError: (err) => toast.error('Could not start the audit', { description: errorMessage(err) }) },
    );

  const status = (s: SecuritySection): ReactNode => {
    if (!data) return null;
    if (s === 'findings') {
      const open = findings.filter((f) => f.status === 'open');
      if (!open.length) return null;
      return <RailBadge tone={open.some((f) => f.severity === 'critical' || f.severity === 'high') ? 'danger' : 'muted'}>{open.length}</RailBadge>;
    }
    if (s === 'audits') {
      if (latestAudit?.status === 'running') return <Spinner className="size-3.5" aria-label="Audit running" />;
      if (latestAudit?.status === 'waiting') return <MessageCircleQuestion className="size-3.5 text-warning" aria-label="Waiting for you in T3" />;
      if (latestAudit?.status === 'failed') return <TriangleAlert className="size-3.5 text-destructive" aria-label="Last audit failed" />;
      return audits.length ? <RailBadge>{audits.length}</RailBadge> : null;
    }
    if (s === 'secrets' || s === 'dependencies') {
      const last = latestScan(data.scans, s);
      if (last?.status === 'running' || scanning === s) return <Spinner className="size-3.5" aria-label="Scanning" />;
      if (last?.status === 'failed') return <TriangleAlert className="size-3.5 text-destructive" aria-label="Last scan failed" />;
      const open = findings.filter((f) => f.source === s && f.status === 'open').length;
      return open ? <RailBadge>{open}</RailBadge> : null;
    }
    return null;
  };

  const { label, icon: Icon } = SECTION_INFO[section];
  const scanKind = section === 'secrets' || section === 'dependencies' ? section : null;
  const scanBusy = scanKind ? latestScan(data?.scans, scanKind)?.status === 'running' || scanning === scanKind : false;

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface/40 md:flex">
        <nav aria-label="Security" className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin">
          <ul className="flex flex-col gap-0.5">
            {SECURITY_SECTIONS.map((s, i) => {
              const info = SECTION_INFO[s];
              return (
                <li key={s} className={cn(i === 3 && 'mt-3')}>
                  {i === 3 && <p className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">Scans</p>}
                  <button
                    type="button"
                    onClick={() => go(s)}
                    aria-current={s === section ? 'page' : undefined}
                    className={cn(
                      'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                      s === section ? 'bg-accent font-medium text-foreground' : 'text-foreground/85',
                    )}
                  >
                    <info.icon className={cn('size-4 shrink-0', s === section ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="min-w-0 flex-1 truncate">{info.label}</span>
                    {status(s)}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <p className="shrink-0 border-t border-border px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Audits are read-only agent runs. The scans run here; the dependency check sends only package names and versions to OSV.dev.
        </p>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="-ml-1.5 min-w-0 md:hidden" aria-label={`Section: ${label}`}>
                <Icon className="text-primary" />
                <span className="truncate text-[13px] font-medium">{label}</span>
                <ChevronDown className="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {SECURITY_SECTIONS.map((s) => {
                const info = SECTION_INFO[s];
                return (
                  <DropdownMenuItem key={s} onSelect={() => go(s)} className={cn(s === section && 'bg-accent')}>
                    <info.icon />
                    <span className="min-w-0 flex-1 truncate">{info.label}</span>
                    {status(s)}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <h2 className="hidden min-w-0 items-center gap-2 text-[13px] font-medium md:flex">
            <Icon className="size-4 shrink-0 text-primary" />
            <span className="truncate">{label}</span>
          </h2>
          <div className="ml-auto flex items-center gap-1.5">
            <Tip content="Download a Markdown report of the findings, the latest audit and the scans">
              <Button variant="ghost" size="sm" asChild>
                <a href={api.securityReportUrl(board.id)} download>
                  <Download />
                  <span className="hidden sm:inline">Report</span>
                </a>
              </Button>
            </Tip>
            {scanKind ? (
              <Button size="sm" onClick={() => scan(scanKind)} disabled={scanBusy || q.isLoading}>
                {scanBusy ? <Spinner className="size-3.5" /> : <Play />}
                {scanBusy ? 'Scanning…' : 'Scan now'}
              </Button>
            ) : (
              <Tip content={auditRunning ? `Audit #${latestAudit?.number ?? ''} is still running` : 'An agent audits the project; it changes nothing'}>
                <span>
                  <Button size="sm" onClick={() => setDialog({})} disabled={auditRunning || q.isLoading}>
                    {auditRunning ? <Spinner className="size-3.5" /> : <ScanSearch />}
                    {auditRunning ? 'Auditing…' : 'New audit'}
                  </Button>
                </span>
              </Tip>
            )}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {q.isLoading || !data ? (
            q.isError ? (
              <p className="mx-auto max-w-6xl px-5 py-6 text-[13px] text-destructive">Could not load the security view: {errorMessage(q.error)}</p>
            ) : (
              <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-4 sm:px-5">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                  {Array.from({ length: 5 }, (_, i) => (
                    <Skeleton key={i} className="h-[86px]" />
                  ))}
                </div>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <Skeleton className="h-56" />
                  <Skeleton className="h-56" />
                </div>
              </div>
            )
          ) : section === 'overview' ? (
            <OverviewPanel
              data={data}
              onSelect={go}
              onOpenFinding={openFinding}
              onNewAudit={() => setDialog({})}
              onAuditChanges={() => setDialog({ preset: { scope: 'changes' } })}
              onRetryAudit={() => latestAudit && retry(latestAudit)}
              onScan={scan}
              scanning={scanning}
            />
          ) : section === 'findings' ? (
            <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-4 sm:px-5">
              <FindingsList
                findings={findings}
                focus={findingParam}
                emptyHint="Findings come from audits and the two scans. Start an audit, or run the scans from their sections."
              />
            </div>
          ) : section === 'audits' ? (
            <AuditsPanel
              audits={audits}
              findings={findings}
              selected={auditParam}
              onSelect={(n) => go('audits', { audit: String(n) })}
              onNew={() => setDialog({})}
              onRetry={retry}
              onOpenFinding={openFinding}
            />
          ) : (
            <ScanPanel
              kind={section}
              scan={latestScan(data.scans, section)}
              findings={findings}
              focus={findingParam}
              starting={scanning === section}
            />
          )}
        </div>
      </section>

      <AuditDialog
        open={dialog !== null}
        onOpenChange={(v) => !v && setDialog(null)}
        lastDone={lastDone}
        commitsSince={data?.commitsSinceAudit ?? null}
        preset={dialog?.preset}
        onStarted={onAuditStarted}
      />
    </div>
  );
}
