// Audits: every audit, newest first, and the chosen one's report: what it concluded, the attack
// surface, what it checked, and the findings it reported or found fixed.
import {
  findingRef,
  SECURITY_CATEGORY_INFO,
  type AuditCoverageStatus,
  type SecurityAuditView,
  type SecurityFindingView,
} from '@t3-orchestra/shared';
import { Check, CircleDashed, CircleMinus, MessageCircleQuestion, RotateCcw, ScanSearch, TriangleAlert } from 'lucide-react';
import { Markdown } from '@/components/Markdown';
import { OpenInT3 } from '@/components/ideas/IdeasView';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { absoluteTime, formatDuration, relativeTime, toMs, useNow } from '@/lib/time';
import { cn } from '@/lib/utils';
import { SeverityBadge } from './FindingCard';
import { SCOPE_LABELS, shortSha } from './model';

/** What an audit is doing, or how it ended when that needs saying. */
export function AuditStatus({ audit, onRetry }: { audit: SecurityAuditView; onRetry?: () => void }) {
  const now = useNow();
  const box = 'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 text-[13px]';
  if (audit.status === 'running') {
    return (
      <div className={cn(box, 'border-border bg-card')} aria-live="polite">
        <Spinner className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          Audit #{audit.number} is reading the code as an attacker would…
          <span className="ml-2 font-mono text-xs text-muted-foreground tabular">{formatDuration(now - (toMs(audit.createdAt) ?? now))}</span>
        </span>
        <OpenInT3 link={audit.threadLink} />
      </div>
    );
  }
  if (audit.status === 'waiting') {
    return (
      <div className={cn(box, 'border-warning/35 bg-warning/10')} aria-live="polite">
        <MessageCircleQuestion className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">Audit #{audit.number} is waiting for you in T3. Answer it there and it carries on here.</span>
        <OpenInT3 link={audit.threadLink} variant="warning" />
      </div>
    );
  }
  if (audit.status === 'failed') {
    return (
      <div className={cn(box, 'border-destructive/35 bg-destructive/8')} role="alert">
        <TriangleAlert className="size-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">Audit #{audit.number} failed.</span> <span className="text-muted-foreground">{audit.error}</span>
        </span>
        <OpenInT3 link={audit.threadLink} />
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <RotateCcw />
            Try again
          </Button>
        )}
      </div>
    );
  }
  return null;
}

function scopeText(a: SecurityAuditView): string {
  if (a.scope === 'paths') return `Paths: ${a.paths.join(', ')}`;
  if (a.scope === 'changes') return `Changes ${shortSha(a.baseSha)}..${shortSha(a.headSha)}`;
  return SCOPE_LABELS.full;
}

const focusText = (a: SecurityAuditView) =>
  a.focus.length === 0 ? 'every area' : a.focus.length <= 2 ? a.focus.map((f) => SECURITY_CATEGORY_INFO[f].label).join(', ') : `${a.focus.length} areas`;

function AuditRow({ audit: a, selected, onSelect }: { audit: SecurityAuditView; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
          selected ? 'border-primary/40 bg-primary/6' : 'border-transparent hover:bg-accent',
        )}
      >
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <span className="font-mono text-xs text-muted-foreground tabular">#{a.number}</span>
          <span className="min-w-0 flex-1 truncate">{scopeText(a)}</span>
          {a.status === 'running' && <Spinner className="size-3.5" aria-label="Running" />}
          {a.status === 'waiting' && <MessageCircleQuestion className="size-3.5 text-warning" aria-label="Waiting for you in T3" />}
          {a.status === 'failed' && <TriangleAlert className="size-3.5 text-destructive" aria-label="Failed" />}
        </span>
        <span className="flex flex-wrap gap-x-2 text-[11.5px] text-muted-foreground">
          <span title={absoluteTime(a.createdAt)}>{relativeTime(a.createdAt)}</span>
          <span>· {focusText(a)}</span>
          {a.status === 'done' && (
            <span>
              · {a.foundCount} new{a.resolvedCount > 0 && `, ${a.resolvedCount} fixed`}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

const COVERAGE: Record<AuditCoverageStatus, { label: string; icon: typeof Check; className: string }> = {
  ok: { label: 'OK', icon: Check, className: 'text-success' },
  issues: { label: 'Issues', icon: TriangleAlert, className: 'text-warning' },
  not_applicable: { label: 'Not applicable', icon: CircleMinus, className: 'text-muted-foreground' },
  not_checked: { label: 'Not checked', icon: CircleDashed, className: 'text-muted-foreground' },
};

function FindingLine({ finding: f, onOpen }: { finding: SecurityFindingView; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
        <SeverityBadge severity={f.severity} />
        <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground tabular">{findingRef(f.number)}</span>
        <span className="min-w-0 flex-1 truncate">{f.title}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{f.status === 'added' ? 'on the board' : f.status}</span>
      </button>
    </li>
  );
}

function AuditReport({
  audit: a,
  findings,
  onOpenFinding,
  onRetry,
}: {
  audit: SecurityAuditView;
  findings: SecurityFindingView[];
  onOpenFinding: (f: SecurityFindingView) => void;
  onRetry: (a: SecurityAuditView) => void;
}) {
  const found = findings.filter((f) => f.auditId === a.id);
  const fixed = findings.filter((f) => f.resolvedBy === 'audit' && f.resolvedAuditNumber === a.number);
  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-4" aria-labelledby={`audit-${a.number}`}>
      <header className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 id={`audit-${a.number}`} className="text-[14px] font-semibold tracking-tight">
            Audit #{a.number} · {scopeText(a)}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span title={absoluteTime(a.createdAt)}>Started {relativeTime(a.createdAt)}</span>
            {a.headSha && <> · commit <span className="font-mono">{shortSha(a.headSha)}</span></>}
            {' · '}Focus: {a.focus.length === 0 ? 'every area' : a.focus.map((f) => SECURITY_CATEGORY_INFO[f].label).join(', ')}
          </p>
        </div>
        {a.status === 'done' && <OpenInT3 link={a.threadLink} />}
      </header>

      <AuditStatus audit={a} onRetry={() => onRetry(a)} />

      {a.instructions && (
        <p className="rounded-md border border-border bg-background/40 px-3 py-2 text-[12.5px]">
          <span className="font-medium">Your notes:</span> {a.instructions}
        </p>
      )}

      {a.summary && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Conclusion</h3>
          <Markdown className="text-[13px]">{a.summary}</Markdown>
        </section>
      )}

      {a.status === 'done' && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">
            Found <span className="font-mono tabular">{found.length}</span>
          </h3>
          {found.length ? (
            <ul className="-mx-2 flex flex-col">
              {found.map((f) => (
                <FindingLine key={f.id} finding={f} onOpen={() => onOpenFinding(f)} />
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">Nothing new.</p>
          )}
          {fixed.length > 0 && (
            <>
              <h3 className="pt-2 text-xs font-medium text-muted-foreground">
                Confirmed fixed <span className="font-mono tabular">{fixed.length}</span>
              </h3>
              <ul className="-mx-2 flex flex-col">
                {fixed.map((f) => (
                  <FindingLine key={f.id} finding={f} onOpen={() => onOpenFinding(f)} />
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {a.coverage.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">What it checked</h3>
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {a.coverage.map((c, i) => {
              const info = COVERAGE[c.status];
              return (
                <li key={i} className="grid grid-cols-[minmax(0,10rem)_auto_1fr] items-start gap-x-3 px-3 py-2 text-[12.5px] max-sm:grid-cols-[1fr_auto]">
                  <span className="font-medium">{c.area}</span>
                  <span className={cn('flex items-center gap-1 text-xs', info.className)}>
                    <info.icon className="size-3.5" />
                    {info.label}
                  </span>
                  <span className="text-muted-foreground max-sm:col-span-2">{c.note}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {a.attackSurface && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Attack surface</h3>
          <Markdown className="text-[12.5px]">{a.attackSurface}</Markdown>
        </section>
      )}
    </article>
  );
}

export function AuditsPanel({
  audits,
  findings,
  selected,
  onSelect,
  onNew,
  onRetry,
  onOpenFinding,
}: {
  audits: SecurityAuditView[];
  findings: SecurityFindingView[];
  selected: number | null;
  onSelect: (n: number) => void;
  onNew: () => void;
  onRetry: (a: SecurityAuditView) => void;
  onOpenFinding: (f: SecurityFindingView) => void;
}) {
  if (audits.length === 0) {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-10">
        <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-border bg-card px-6 py-8 text-center">
          <div className="flex size-11 items-center justify-center rounded-full border border-border bg-background">
            <ScanSearch className="size-5 text-muted-foreground" />
          </div>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-[15px] font-semibold tracking-tight">No audits yet</h2>
            <p className="text-[13px] text-muted-foreground">
              An agent maps the project's entry points and traces untrusted input to where it can do harm. It reports what it can exploit, with the
              code as evidence, and what it checked and found fine. Later audits re-check what is still open.
            </p>
          </div>
          <Button size="lg" onClick={onNew}>
            <ScanSearch />
            Start an audit
          </Button>
        </div>
      </div>
    );
  }
  const current = audits.find((a) => a.number === selected) ?? audits[0]!;
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 items-start gap-4 px-3 py-4 sm:px-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <nav aria-label="Audits" className="lg:sticky lg:top-4">
        <ul className="flex flex-col gap-1">
          {audits.map((a) => (
            <AuditRow key={a.id} audit={a} selected={a.id === current.id} onSelect={() => onSelect(a.number)} />
          ))}
        </ul>
      </nav>
      <AuditReport audit={current} findings={findings} onOpenFinding={onOpenFinding} onRetry={onRetry} />
    </div>
  );
}
