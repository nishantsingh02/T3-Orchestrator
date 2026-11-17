// Dependency scan: the packages in the project's lockfiles, checked against OSV.dev (the open
// vulnerability database behind GitHub, PyPI, Go, RustSec and others). Only package names and
// versions are sent; one finding per vulnerable package, with every advisory and the version that fixes them.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DependencyAdvisory, SecurityScanStats, SecuritySeverity } from '@t3-orchestra/shared';
import * as git from '../git/git.ts';
import type { ScanItem } from './items.ts';
import { collectPackages, lockfileParser, pypiName, type LockedPackage } from './lockfiles.ts';

const OSV = 'https://api.osv.dev/v1';
const BATCH = 1000;
const MAX_DETAILS = 400;
const CONCURRENCY = 8;
const TIMEOUT_MS = 30_000;
const MAX_LOCKFILE_BYTES = 50_000_000;

export interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}
export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  withdrawn?: string;
  severity?: Array<{ type: string; score: string }>;
  affected?: Array<{
    package?: { ecosystem?: string; name?: string };
    ranges?: Array<{ type?: string; events?: OsvEvent[] }>;
    database_specific?: { severity?: string };
  }>;
  database_specific?: { severity?: string };
}

// ---------------------------------------------------------------------------
// Versions and severities
// ---------------------------------------------------------------------------

/** Loose semver-ish order (1.2.10 > 1.2.9, 1.0.0-rc.1 < 1.0.0), good enough to pick a fix version. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main = '', pre = ''] = v.replace(/^v/i, '').split('+')[0]!.split(/-(.*)/s);
    return { main: main.split('.'), pre };
  };
  const seg = (x: string | undefined, y: string | undefined) => {
    const nx = Number(x ?? 0);
    const ny = Number(y ?? 0);
    if (Number.isFinite(nx) && Number.isFinite(ny) && /^\d*$/.test(x ?? '') && /^\d*$/.test(y ?? '')) return nx - ny;
    return (x ?? '').localeCompare(y ?? '');
  };
  const A = split(a);
  const B = split(b);
  for (let i = 0; i < Math.max(A.main.length, B.main.length); i++) {
    const d = seg(A.main[i], B.main[i]);
    if (d !== 0) return Math.sign(d);
  }
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  const pa = A.pre.split('.');
  const pb = B.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const d = seg(pa[i], pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

const roundUp = (x: number) => {
  const i = Math.round(x * 100_000);
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
};

/** CVSS 3.x base score from its vector, or null for anything else. */
export function cvss3Score(vector: string): number | null {
  const m = /^CVSS:3\.[01]\/(.+)$/.exec(vector.trim());
  if (!m) return null;
  const p = Object.fromEntries(m[1]!.split('/').map((kv) => kv.split(':') as [string, string]));
  const changed = p.S === 'C';
  const AV = ({ N: 0.85, A: 0.62, L: 0.55, P: 0.2 } as Record<string, number>)[p.AV!];
  const AC = ({ L: 0.77, H: 0.44 } as Record<string, number>)[p.AC!];
  const PR = ({ N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 } as Record<string, number>)[p.PR!];
  const UI = ({ N: 0.85, R: 0.62 } as Record<string, number>)[p.UI!];
  const cia = { H: 0.56, L: 0.22, N: 0 } as Record<string, number>;
  const [C, I, A] = [cia[p.C!], cia[p.I!], cia[p.A!]];
  if ([AV, AC, PR, UI, C, I, A].some((v) => v === undefined) || (p.S !== 'U' && !changed)) return null;
  const iss = 1 - (1 - C!) * (1 - I!) * (1 - A!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * AV! * AC! * PR! * UI!;
  return roundUp(Math.min((changed ? 1.08 : 1) * (impact + exploitability), 10));
}

export function scoreSeverity(score: number): SecuritySeverity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return score > 0 ? 'low' : 'info';
}

const LABEL_SEVERITY: Record<string, SecuritySeverity> = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low' };

/** The database's own rating (GitHub's), else the CVSS 3 score, else medium. */
export function vulnSeverity(v: OsvVuln): SecuritySeverity {
  const label = v.database_specific?.severity ?? v.affected?.find((a) => a.database_specific?.severity)?.database_specific?.severity;
  if (label && LABEL_SEVERITY[label.toUpperCase()]) return LABEL_SEVERITY[label.toUpperCase()]!;
  for (const s of v.severity ?? []) {
    const score = s.type.startsWith('CVSS_V3') ? cvss3Score(s.score) : null;
    if (score !== null) return scoreSeverity(score);
  }
  return 'medium';
}

const sameName = (ecosystem: string, a: string, b: string) =>
  ecosystem === 'PyPI' ? pypiName(a) === pypiName(b) : a.toLowerCase() === b.toLowerCase();

/** The lowest version above `installed` that the advisory names as fixed, or null. */
export function fixedVersionFor(v: OsvVuln, pkg: Pick<LockedPackage, 'ecosystem' | 'name' | 'version'>): string | null {
  const fixes: string[] = [];
  for (const a of v.affected ?? []) {
    if (a.package?.ecosystem?.split(':')[0] !== pkg.ecosystem || !sameName(pkg.ecosystem, a.package.name ?? '', pkg.name)) continue;
    for (const r of a.ranges ?? []) {
      if (r.type === 'GIT') continue;
      for (const e of r.events ?? []) if (e.fixed && compareVersions(e.fixed, pkg.version) > 0) fixes.push(e.fixed);
    }
  }
  return fixes.sort(compareVersions)[0] ?? null;
}

// ---------------------------------------------------------------------------
// OSV.dev
// ---------------------------------------------------------------------------

async function osvJson<T>(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'content-type': 'application/json', accept: 'application/json' } });
  } catch (err) {
    throw new Error(`Could not reach OSV.dev: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`OSV.dev answered ${res.status} ${res.statusText}`.trim());
  return (await res.json()) as T;
}

/** The ids of the advisories affecting each package, in the packages' order. */
export async function queryOsv(fetchFn: typeof fetch, pkgs: LockedPackage[]): Promise<string[][]> {
  const out: string[][] = [];
  for (let i = 0; i < pkgs.length; i += BATCH) {
    const chunk = pkgs.slice(i, i + BATCH);
    const res = await osvJson<{ results?: Array<{ vulns?: Array<{ id: string }> }> }>(fetchFn, `${OSV}/querybatch`, {
      method: 'POST',
      body: JSON.stringify({ queries: chunk.map((p) => ({ package: { ecosystem: p.ecosystem, name: p.name }, version: p.version })) }),
    });
    chunk.forEach((_, j) => out.push((res.results?.[j]?.vulns ?? []).map((v) => v.id)));
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** The manifest next to a lockfile, where a version is usually raised. */
const MANIFEST: Record<string, string> = {
  'package-lock.json': 'package.json',
  'npm-shrinkwrap.json': 'package.json',
  'pnpm-lock.yaml': 'package.json',
  'yarn.lock': 'package.json',
  'bun.lock': 'package.json',
  'poetry.lock': 'pyproject.toml',
  'uv.lock': 'pyproject.toml',
  'pdm.lock': 'pyproject.toml',
  'Pipfile.lock': 'Pipfile',
  'Cargo.lock': 'Cargo.toml',
  'Gemfile.lock': 'Gemfile',
  'composer.lock': 'composer.json',
  'pubspec.lock': 'pubspec.yaml',
  'mix.lock': 'mix.exs',
};

const RANK: Record<SecuritySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

interface VulnerablePackage {
  ecosystem: string;
  name: string;
  versions: string[];
  lockfiles: string[];
  advisories: DependencyAdvisory[];
}

/** One finding per vulnerable package. */
export function dependencyItems(list: VulnerablePackage[]): ScanItem[] {
  return list.map((p) => {
    const advisories = p.advisories.slice().sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.id.localeCompare(b.id));
    const severity = advisories[0]?.severity ?? 'medium';
    const fixes = advisories.map((a) => a.fixed).filter((f): f is string => f !== null);
    const unfixed = advisories.filter((a) => a.fixed === null);
    const fixedIn = fixes.length ? fixes.sort(compareVersions).at(-1)! : null;
    const versions = p.versions.slice().sort(compareVersions);
    const at = `${p.name} ${versions.join(', ')}`;
    const n = advisories.length;
    const top = advisories[0];
    const title = n === 1 && top?.summary ? `${at}: ${top.summary}`.slice(0, 140) : `${at} has ${n} known vulnerabilities`;
    const fixLine = fixedIn
      ? unfixed.length
        ? `Upgrading to ${fixedIn} fixes ${fixes.length} of the ${n}; ${unfixed.length === 1 ? 'one has' : `${unfixed.length} have`} no fix yet.`
        : `Upgrading to ${fixedIn} fixes ${n === 1 ? 'it' : `all ${n}`}.`
      : 'No fixed version is published yet.';
    const manifests = p.lockfiles
      .map((l) => {
        const m = MANIFEST[path.posix.basename(l)];
        return m ? path.posix.join(path.posix.dirname(l), m) : null;
      })
      .filter((m): m is string => m !== null);
    const table = [
      '| Advisory | Severity | Fixed in | Summary |',
      '| --- | --- | --- | --- |',
      ...advisories.map((a) => `| [${a.id}](${a.url}) | ${a.severity} | ${a.fixed ?? 'not yet'} | ${(a.summary || a.aliases.join(', ') || '').replace(/\|/g, '\\|')} |`),
    ].join('\n');
    return {
      fingerprint: `dep:${p.ecosystem}:${p.name.toLowerCase()}`,
      severity,
      category: 'dependencies',
      title,
      description: `${p.ecosystem} package ${at} is affected by ${n === 1 ? (top?.id ?? 'an advisory') : `${n} advisories`}. ${fixLine}`,
      details: `${table}\n\n**Locked in:** ${p.lockfiles.map((l) => `\`${l}\``).join(', ')}`,
      recommendation: fixedIn
        ? `Upgrade \`${p.name}\` to ${fixedIn} or later. If it comes in through another package, upgrade that one (or pin it with an override or resolution) and regenerate the lockfile. Run the tests afterwards: a bigger version jump can change behavior.`
        : `No release fixes ${n === 1 ? 'it' : 'these'} yet. Check whether the project uses the affected feature, mitigate where the code calls it, or look for a maintained alternative.`,
      file: p.lockfiles[0] ?? null,
      line: null,
      cwe: 'CWE-1395',
      confidence: 'high',
      acceptanceCriteria: fixedIn
        ? [`${p.name} resolves to ${fixedIn} or later in ${p.lockfiles.join(', ')}`, 'The dependency scan no longer reports it', 'The tests pass']
        : [`The affected ${p.name} feature is not reachable, or ${p.name} is replaced`, 'The tests pass'],
      touches: [...new Set([...p.lockfiles, ...manifests])],
      meta: { kind: 'dependency', ecosystem: p.ecosystem, name: p.name, versions, lockfiles: p.lockfiles, fixedIn, advisories },
    } satisfies ScanItem;
  });
}

export async function scanDependencies(root: string, fetchFn: typeof fetch): Promise<{ items: ScanItem[]; stats: SecurityScanStats }> {
  const notes: string[] = [];
  const tracked = await git.trackedFiles(root);
  const files: Array<{ file: string; text: string }> = [];
  for (const file of tracked) {
    if (!lockfileParser(file)) continue;
    try {
      const st = await fs.stat(path.join(root, file));
      if (st.size > MAX_LOCKFILE_BYTES) {
        notes.push(`${file} is over 50 MB and was skipped.`);
        continue;
      }
      files.push({ file, text: await fs.readFile(path.join(root, file), 'utf8') });
    } catch {
      // deleted in the working tree
    }
  }
  const { packages, errors } = collectPackages(files);
  for (const e of errors) notes.push(`Could not read ${e}`);
  const stats: SecurityScanStats = {
    lockfiles: files.map((f) => f.file),
    packages: packages.length,
    ecosystems: [...new Set(packages.map((p) => p.ecosystem))].sort(),
    vulnerable: 0,
    notes,
  };
  if (packages.length === 0) return { items: [], stats };

  const ids = await queryOsv(fetchFn, packages);
  const unique = [...new Set(ids.flat())];
  const fetched = unique.slice(0, MAX_DETAILS);
  if (unique.length > fetched.length) notes.push(`Only the first ${MAX_DETAILS} of ${unique.length} advisories were read in full.`);
  const details = new Map<string, OsvVuln | null>(
    (await pool(fetched, CONCURRENCY, async (id) => [id, await osvJson<OsvVuln>(fetchFn, `${OSV}/vulns/${encodeURIComponent(id)}`).catch(() => null)] as const)),
  );

  const byPackage = new Map<string, VulnerablePackage>();
  packages.forEach((pkg, i) => {
    const vulnIds = ids[i] ?? [];
    if (!vulnIds.length) return;
    const key = `${pkg.ecosystem}|${pkg.name.toLowerCase()}`;
    const entry = byPackage.get(key) ?? { ecosystem: pkg.ecosystem, name: pkg.name, versions: [], lockfiles: [], advisories: [] };
    byPackage.set(key, entry);
    if (!entry.versions.includes(pkg.version)) entry.versions.push(pkg.version);
    for (const l of pkg.lockfiles) if (!entry.lockfiles.includes(l)) entry.lockfiles.push(l);
    // GitHub's advisories first: they carry a severity. Their aliases (CVE, PYSEC…) are the same issue.
    const ordered = vulnIds.slice().sort((a, b) => Number(!a.startsWith('GHSA-')) - Number(!b.startsWith('GHSA-')));
    for (const id of ordered) {
      const v = details.get(id) ?? null;
      if (v?.withdrawn) continue;
      const aliases = v?.aliases ?? [];
      const fixed = v ? fixedVersionFor(v, pkg) : null;
      const known = entry.advisories.find((a) => a.id === id || a.aliases.includes(id) || aliases.includes(a.id) || a.aliases.some((x) => aliases.includes(x)));
      if (known) {
        // The same issue again (an alias, or another installed version): keep the higher fix, so one upgrade covers all.
        if (fixed && (!known.fixed || compareVersions(fixed, known.fixed) > 0)) known.fixed = fixed;
        continue;
      }
      entry.advisories.push({
        id,
        aliases: v?.aliases ?? [],
        summary: (v?.summary ?? v?.details?.split('\n')[0] ?? '').trim().slice(0, 200),
        severity: v ? vulnSeverity(v) : 'medium',
        fixed,
        url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
      });
    }
  });
  const vulnerable = [...byPackage.values()].filter((p) => p.advisories.length > 0);
  stats.vulnerable = vulnerable.length;
  return { items: dependencyItems(vulnerable), stats };
}
