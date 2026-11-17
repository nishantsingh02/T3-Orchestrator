// The Secrets and Dependencies sections: what the scan checks, how its last run went, and its findings.
import type { SecurityFindingView, SecurityScanKind, SecurityScanView } from '@t3-orchestra/shared';
import { Info, KeyRound, Package, TriangleAlert } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { absoluteTime, relativeTime } from '@/lib/time';
import { pluralize } from '@/lib/utils';
import { FindingsList } from './FindingsList';

const ABOUT: Record<SecurityScanKind, { title: string; icon: typeof KeyRound; body: string; privacy: string; empty: string }> = {
  secrets: {
    title: 'Secret scan',
    icon: KeyRound,
    body: 'Looks for API keys and tokens (GitHub, AWS, Stripe, OpenAI, Anthropic, Slack…), private keys, passwords in connection strings, hard-coded secrets and committed .env files, in the tracked files of the root checkout and in its last 300 commits.',
    privacy: 'Runs on this machine; nothing is sent anywhere. Findings keep a short preview of each secret, never the secret.',
    empty: 'Run the scan to check the code and its recent history for leaked keys.',
  },
  dependencies: {
    title: 'Dependency scan',
    icon: Package,
    body: 'Reads the lockfiles (npm, pnpm, Yarn, Bun, pip, Poetry, uv, Cargo, Go, Bundler, Composer, NuGet, Pub, Gradle, Mix) and checks every installed version against OSV.dev, the open database behind GitHub, PyPI, Go and RustSec advisories.',
    privacy: 'Sends package names and versions to OSV.dev; no code leaves the machine.',
    empty: 'Run the scan to check the installed packages for known vulnerabilities.',
  },
};

function statsLine(scan: SecurityScanView): string {
  const s = scan.stats;
  if (scan.kind === 'secrets') return `Read ${pluralize(s.files ?? 0, 'file')} and ${pluralize(s.commits ?? 0, 'commit')}.`;
  const lockfiles = s.lockfiles?.length ?? 0;
  if (lockfiles === 0) return 'No lockfiles found in the tracked files.';
  return `${pluralize(s.packages ?? 0, 'package')} in ${pluralize(lockfiles, 'lockfile')} (${(s.ecosystems ?? []).join(', ')}), ${s.vulnerable ?? 0} with known vulnerabilities.`;
}

/** What the scan checks and how its last run went; the header's Scan now button runs it. */
export function ScanCard({ kind, scan, starting }: { kind: SecurityScanKind; scan: SecurityScanView | undefined; starting: boolean }) {
  const about = ABOUT[kind];
  const running = scan?.status === 'running' || starting;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4" aria-labelledby={`scan-${kind}`}>
      <header className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <about.icon className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id={`scan-${kind}`} className="text-[13.5px] font-semibold tracking-tight">
            {about.title}
          </h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{about.body}</p>
        </div>
        {running && <Spinner className="mt-1 size-4" aria-label="Scanning" />}
      </header>
      <p className="flex items-start gap-1.5 text-[11.5px] text-muted-foreground">
        <Info className="mt-px size-3.5 shrink-0" />
        {about.privacy}
      </p>
      {scan && scan.status !== 'running' && (
        <div className="flex flex-col gap-1 border-t border-border pt-3 text-[12.5px]">
          {scan.status === 'failed' ? (
            <p className="flex items-start gap-1.5 text-destructive" role="alert">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span>
                The last scan failed <span title={absoluteTime(scan.finishedAt)}>{relativeTime(scan.finishedAt)}</span>: {scan.error}
              </span>
            </p>
          ) : (
            <p>
              <span className="text-muted-foreground" title={absoluteTime(scan.finishedAt)}>
                Last scan {relativeTime(scan.finishedAt)}.
              </span>{' '}
              {statsLine(scan)}
              {(scan.newCount > 0 || scan.fixedCount > 0) && (
                <span className="text-muted-foreground">
                  {' '}
                  {scan.newCount > 0 && `${scan.newCount} new`}
                  {scan.newCount > 0 && scan.fixedCount > 0 && ', '}
                  {scan.fixedCount > 0 && `${scan.fixedCount} no longer found`}.
                </span>
              )}
            </p>
          )}
          {scan.stats.notes?.map((n, i) => (
            <p key={i} className="text-[11.5px] text-muted-foreground">
              {n}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

export function ScanPanel({
  kind,
  scan,
  findings,
  focus,
  starting,
}: {
  kind: SecurityScanKind;
  scan: SecurityScanView | undefined;
  findings: SecurityFindingView[];
  focus: number | null;
  starting: boolean;
}) {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-4 sm:px-5">
      <ScanCard kind={kind} scan={scan} starting={starting} />
      <FindingsList findings={findings} source={kind} focus={focus} emptyHint={scan ? 'The last scan found nothing.' : `${ABOUT[kind].empty} Use Scan now above.`} />
    </div>
  );
}
