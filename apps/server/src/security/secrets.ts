// Secret scan: known token formats, private keys, connection strings with passwords and committed
// .env files, in the tracked files of the root checkout and in its recent commits. It runs locally
// (nothing leaves the machine) and keeps only a short preview and a hash of each secret.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SecretLocation, SecurityScanStats, SecuritySeverity } from '@t3-orchestra/shared';
import * as git from '../git/git.ts';
import type { ScanItem } from './items.ts';

export interface SecretRule {
  id: string;
  /** "GitHub token": names the finding. */
  label: string;
  severity: SecuritySeverity;
  /** Global regex; capture group `group` (default 1) is the secret. */
  re: RegExp;
  /** The rule only runs on text containing one of these (cheap skip). */
  hints?: string[];
  group?: number;
  /** Drops the match (null) or changes its severity. */
  check?: (secret: string, m: RegExpExecArray) => SecuritySeverity | null | undefined;
  cwe?: string;
}

const PLACEHOLDER = /example|sample|dummy|placeholder|changeme|change_me|your[_-]|xxxx|\*\*\*|<[a-z_ -]+>|\$\{|\{\{|redacted|fake|insert|replace_?me|todo/i;

/** Bits of entropy per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksPlaceholder(v: string): boolean {
  return PLACEHOLDER.test(v) || /^(.)\1+$/.test(v) || /^[0-9]+$/.test(v);
}

/** JWT payload's `role` claim, when it decodes. */
function jwtRole(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { role?: unknown };
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal|[a-z0-9_-]+)(:\d+)?$/i;

export const SECRET_RULES: SecretRule[] = [
  {
    id: 'private_key',
    label: 'Private key',
    severity: 'critical',
    re: /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----[\s\S]{0,120}/g,
    hints: ['PRIVATE KEY'],
    group: 0,
    check: (_s, m) => (m[1]?.startsWith('ENCRYPTED') ? 'medium' : undefined),
    cwe: 'CWE-321',
  },
  { id: 'aws_access_key', label: 'AWS access key ID', severity: 'high', re: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g, hints: ['AKIA', 'ASIA', 'ABIA', 'ACCA'] },
  {
    id: 'aws_secret_key',
    label: 'AWS secret access key',
    severity: 'critical',
    re: /aws.{0,24}?(?:secret|sk).{0,24}?['"=:\s]\s*['"]?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    hints: ['aws', 'AWS', 'Aws'],
  },
  { id: 'github_token', label: 'GitHub token', severity: 'critical', re: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255})\b/g, hints: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'] },
  { id: 'github_pat', label: 'GitHub token', severity: 'critical', re: /\b(github_pat_[A-Za-z0-9_]{60,255})\b/g, hints: ['github_pat_'] },
  { id: 'gitlab_token', label: 'GitLab token', severity: 'critical', re: /\b(glpat-[A-Za-z0-9_-]{20,})\b/g, hints: ['glpat-'] },
  { id: 'slack_token', label: 'Slack token', severity: 'high', re: /\b(xox[baprs]-[A-Za-z0-9-]{10,250})\b/g, hints: ['xox'] },
  {
    id: 'slack_webhook',
    label: 'Slack webhook URL',
    severity: 'medium',
    re: /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,})/g,
    hints: ['hooks.slack.com'],
  },
  {
    id: 'stripe_key',
    label: 'Stripe secret key',
    severity: 'critical',
    re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/g,
    hints: ['sk_live_', 'rk_live_', 'sk_test_', 'rk_test_'],
    // A test-mode key can't move money, but it can read and change the test account.
    check: (s) => (s.includes('_test_') ? 'low' : undefined),
  },
  { id: 'google_api_key', label: 'Google API key', severity: 'medium', re: /\b(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/g, hints: ['AIza'] },
  { id: 'google_oauth_secret', label: 'Google OAuth client secret', severity: 'high', re: /\b(GOCSPX-[A-Za-z0-9_-]{28})(?![A-Za-z0-9_-])/g, hints: ['GOCSPX-'] },
  {
    id: 'openai_key',
    label: 'OpenAI API key',
    severity: 'critical',
    re: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,})(?![A-Za-z0-9_-])/g,
    hints: ['sk-'],
  },
  { id: 'anthropic_key', label: 'Anthropic API key', severity: 'critical', re: /\b(sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,})(?![A-Za-z0-9_-])/g, hints: ['sk-ant-'] },
  { id: 'npm_token', label: 'npm token', severity: 'critical', re: /\b(npm_[A-Za-z0-9]{36})\b/g, hints: ['npm_'] },
  { id: 'pypi_token', label: 'PyPI token', severity: 'critical', re: /\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,})(?![A-Za-z0-9_-])/g, hints: ['pypi-'] },
  { id: 'sendgrid_key', label: 'SendGrid API key', severity: 'high', re: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g, hints: ['SG.'] },
  { id: 'twilio_key', label: 'Twilio API key', severity: 'medium', re: /\b(SK[0-9a-f]{32})\b/g, hints: ['SK'] },
  { id: 'telegram_bot_token', label: 'Telegram bot token', severity: 'high', re: /\b(\d{8,10}:AA[A-Za-z0-9_-]{33})(?![A-Za-z0-9_-])/g, hints: [':AA'] },
  {
    id: 'jwt',
    label: 'JSON Web Token',
    severity: 'medium',
    re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})(?![A-Za-z0-9_-])/g,
    hints: ['eyJ'],
    // Supabase keys are JWTs: the anon key is public by design, the service role key bypasses row security.
    check: (s) => {
      const role = jwtRole(s);
      if (role === 'anon') return null;
      return role === 'service_role' ? 'critical' : undefined;
    },
  },
  {
    id: 'connection_string',
    label: 'Connection string with a password',
    severity: 'high',
    re: /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/[^\s:'"@/]+:([^\s'"@/]{3,})@([^\s'"/?#]+))/g,
    hints: ['://'],
    check: (_s, m) => {
      const password = m[2] ?? '';
      if (looksPlaceholder(password) || /^(password|pass|secret|postgres|root|admin|mysql|guest|user)$/i.test(password)) return 'low';
      // A local or docker-compose host: a development database, usually.
      return LOCAL_HOST.test(m[3] ?? '') ? 'low' : undefined;
    },
  },
  {
    id: 'generic_secret',
    label: 'Hard-coded secret',
    severity: 'medium',
    re: /(?:^|[\s{,;(])["']?[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["'`]([^"'`\s]{12,200})["'`]/gim,
    check: (s) => {
      if (looksPlaceholder(s) || /^https?:/i.test(s) || !/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) return null;
      return entropy(s) >= 3.3 ? undefined : null;
    },
  },
];

const RULES_BY_ID = new Map(SECRET_RULES.map((r) => [r.id, r]));

const SKIP_EXT = new Set(
  (
    'png jpg jpeg gif webp ico bmp tif tiff svg avif heic psd ai sketch fig woff woff2 ttf otf eot zip gz tgz bz2 xz 7z rar jar war ear ' +
    'mp3 mp4 mov webm wav ogg flac m4a avi mkv pdf exe dll so dylib bin wasm class pyc pyo o a lib obj map snap ' +
    'sqlite db parquet pkl npy npz onnx pt ckpt'
  ).split(' '),
);
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'pdm.lock',
  'Pipfile.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',
  'packages.lock.json',
  'pubspec.lock',
  'gradle.lockfile',
  'mix.lock',
]);
const MAX_FILE_BYTES = 1_500_000;

/** Files the scan doesn't read: binaries, media, lockfiles (full of hashes), minified bundles. */
export function skipFile(file: string): boolean {
  const base = path.posix.basename(file);
  if (LOCKFILES.has(base)) return true;
  if (/\.min\.(js|css)$/i.test(base)) return true;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return SKIP_EXT.has(ext) || /(^|\/)(node_modules|vendor|\.git)\//.test(file);
}

/** Tests, fixtures, examples and docs: keys there are often fake, so findings there count one level lower. */
export function isTestPath(file: string): boolean {
  return /(^|\/)(tests?|__tests__|specs?|fixtures?|__fixtures__|mocks?|__mocks__|examples?|samples?|testdata|docs?)(\/|$)|\.(test|spec)\.[a-z]+$|\.mdx?$/i.test(file);
}

/** `.env`, `.env.production`, `prod.env`… but not the example files meant to be committed. */
export function isEnvFile(file: string): boolean {
  const base = path.posix.basename(file).toLowerCase();
  if (!/^\.env(\..+)?$/.test(base) && !/\.env$/.test(base)) return false;
  return !/(example|sample|template|dist|defaults|schema|tpl)/.test(base);
}

const LOWER: Record<SecuritySeverity, SecuritySeverity> = { critical: 'high', high: 'medium', medium: 'low', low: 'low', info: 'info' };
const RANK: Record<SecuritySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const worst = (a: SecuritySeverity, b: SecuritySeverity) => (RANK[a] <= RANK[b] ? a : b);

export interface SecretHit {
  ruleId: string;
  hash: string;
  preview: string;
  severity: SecuritySeverity;
  file: string;
  line: number;
  commit: string | null;
}

export function secretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 20);
}

/** The first few characters, so the user can tell which key it is without the finding repeating it. */
export function secretPreview(secret: string): string {
  if (secret.startsWith('-----BEGIN')) return secret.split('-----').slice(0, 3).join('-----') + '-----';
  const shown = Math.min(6, Math.max(2, Math.floor(secret.length / 6)));
  return `${secret.slice(0, shown)}… (${secret.length} characters)`;
}

/** Matches in one text. `lineOf` maps a 1-based line in `text` to the line to report. */
export function scanText(text: string, file: string, commit: string | null = null, lineOf: (n: number) => number = (n) => n): SecretHit[] {
  const hits: SecretHit[] = [];
  const test = isTestPath(file);
  let lineStarts: number[] | null = null;
  const lineAt = (index: number) => {
    lineStarts ??= [0, ...[...text.matchAll(/\n/g)].map((m) => m.index! + 1)];
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  // The generic rule runs last and skips what a specific rule already named.
  const named = new Set<string>();
  for (const rule of SECRET_RULES) {
    if (rule.hints && !rule.hints.some((h) => text.includes(h))) continue;
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(text); m; m = rule.re.exec(text)) {
      if (m[0].length === 0) rule.re.lastIndex++;
      const secret = (m[rule.group ?? 1] ?? '').trim();
      if (!secret || (rule.id === 'generic_secret' && [...named].some((s) => s.includes(secret) || secret.includes(s)))) continue;
      const verdict = rule.check?.(secret, m);
      if (verdict === null) continue;
      // Documented example keys (AWS's AKIAIOSFODNN7EXAMPLE and friends).
      if (rule.id !== 'private_key' && /EXAMPLE/i.test(secret)) continue;
      named.add(secret);
      let severity = verdict ?? rule.severity;
      if (test) severity = LOWER[severity];
      const keyText = rule.id === 'private_key' ? secret.replace(/\s+/g, '') : secret;
      hits.push({
        ruleId: rule.id,
        hash: secretHash(keyText),
        preview: secretPreview(secret),
        severity,
        file,
        line: lineOf(lineAt(m.index + (m[0].length - m[0].trimStart().length))),
        commit,
      });
    }
  }
  return hits;
}

const ENV_SECRET_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET|DSN|DATABASE_URL|CREDENTIALS?|AUTH)/i;

/** The keys of a committed env file that have values, split into secret-looking ones and the rest. */
export function envFileKeys(text: string): { secret: string[]; other: string[] } {
  const secret: string[] = [];
  const other: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    const value = m[2]!.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!value) continue;
    if (!ENV_SECRET_KEY.test(m[1]!)) other.push(m[1]!);
    else if (!looksPlaceholder(value)) secret.push(m[1]!);
  }
  return { secret, other };
}

// ---------------------------------------------------------------------------
// Turning hits into findings
// ---------------------------------------------------------------------------

const SECRET_FIX = [
  '1. **Revoke or rotate it at the provider first.** Treat it as leaked: removing it from the code does not take it out of anyone’s clone.',
  '2. Remove it from the code and read it from an environment variable or a secret store instead; keep a `.env.example` with empty values.',
  '3. If the repository is or was ever public, also purge it from the git history (`git filter-repo` or BFG) after rotating.',
].join('\n');

const short = (sha: string | null) => (sha ? sha.slice(0, 8) : '');
const where = (l: SecretLocation) => `\`${l.file}:${l.line}\`${l.commit ? ` (commit ${short(l.commit)})` : ''}`;

export function secretItems(hits: SecretHit[], envFiles: Array<{ file: string; secret: string[]; other: string[] }>): ScanItem[] {
  const groups = new Map<string, SecretHit[]>();
  for (const h of hits) {
    const key = `${h.ruleId}:${h.hash}`;
    const list = groups.get(key);
    if (list) list.push(h);
    else groups.set(key, [h]);
  }
  const items: ScanItem[] = [];
  for (const [key, list] of groups) {
    const rule = RULES_BY_ID.get(list[0]!.ruleId)!;
    // Current files first, then the newest commits (the log is read newest first).
    const current = list.filter((h) => h.commit === null);
    const ordered = [...current, ...list.filter((h) => h.commit !== null)];
    const seen = new Set<string>();
    const locations: SecretLocation[] = [];
    for (const h of ordered) {
      const k = `${h.file}|${h.commit ?? ''}`;
      if (seen.has(k) || (h.commit && current.some((c) => c.file === h.file))) continue;
      seen.add(k);
      locations.push({ file: h.file, line: h.line, commit: h.commit });
    }
    const inHistoryOnly = current.length === 0;
    // Severity of the copy that's worst: a key that is also outside tests counts in full.
    const severity = (inHistoryOnly ? list : current).map((h) => h.severity).reduce(worst);
    const first = locations[0]!;
    const more = locations.length > 1 ? ` (and ${locations.length - 1} more place${locations.length > 2 ? 's' : ''})` : '';
    const description = inHistoryOnly
      ? `${rule.label} committed in ${short(first.commit)} (${first.file}) and removed later, but still in the git history${more}.`
      : `${rule.label} committed in ${first.file}:${first.line}${more}. Anyone who can read the repository can use it.`;
    items.push({
      fingerprint: `secret:${key}`,
      severity,
      category: 'secrets',
      title: inHistoryOnly ? `${rule.label} in the git history (${first.file})` : `${rule.label} in ${first.file}`,
      description,
      details: [
        `**What:** ${rule.label} \`${list[0]!.preview}\``,
        `**Where:**\n${locations.slice(0, 10).map((l) => `- ${where(l)}`).join('\n')}${locations.length > 10 ? `\n- … and ${locations.length - 10} more` : ''}`,
        inHistoryOnly ? 'It is no longer in the current files, so only the history and existing clones still hold it.' : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      recommendation: SECRET_FIX,
      file: first.file,
      line: first.line,
      cwe: rule.cwe ?? 'CWE-798',
      confidence: rule.id === 'generic_secret' ? 'low' : rule.id === 'jwt' || rule.id === 'twilio_key' ? 'medium' : 'high',
      acceptanceCriteria: [
        'The leaked value is no longer in the code; it is read from configuration at runtime',
        'The old value has been revoked or rotated at the provider',
        'The secret scan no longer reports it',
      ],
      touches: [...new Set(locations.filter((l) => !l.commit).map((l) => l.file))],
      meta: { kind: 'secret', rule: rule.id, preview: list[0]!.preview, inHistoryOnly, locations: locations.slice(0, 20) },
    });
  }
  for (const env of envFiles) {
    const hasSecrets = env.secret.length > 0;
    if (!hasSecrets && env.other.length === 0) continue;
    const keys = hasSecrets ? env.secret : env.other;
    items.push({
      fingerprint: `secret:env_file:${env.file}`,
      severity: isTestPath(env.file) ? LOWER[hasSecrets ? 'high' : 'low'] : hasSecrets ? 'high' : 'low',
      category: 'secrets',
      title: `Environment file committed: ${env.file}`,
      description: hasSecrets
        ? `${env.file} is in git with values for ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ` and ${keys.length - 4} more` : ''}.`
        : `${env.file} is in git. Nothing in it looks secret now, but the next value someone adds will be committed too.`,
      details: `**Keys with values:** ${[...env.secret, ...env.other].map((k) => `\`${k}\``).join(', ')}`,
      recommendation: [
        `1. Stop tracking it: \`git rm --cached ${env.file}\`, and add it to \`.gitignore\`.`,
        '2. Commit an `.env.example` with the same keys and empty values instead.',
        hasSecrets ? '3. Rotate the values that were in it: they are in the git history.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
      file: env.file,
      line: null,
      cwe: 'CWE-538',
      confidence: 'high',
      acceptanceCriteria: [`${env.file} is no longer tracked and is listed in .gitignore`, 'An example file documents the keys without values'],
      touches: [env.file, '.gitignore'],
      meta: { kind: 'secret', rule: 'env_file', preview: keys.slice(0, 6).join(', '), inHistoryOnly: false, locations: [{ file: env.file, line: 1, commit: null }] },
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** Added lines of each file in each recent commit, newest first. */
export function* addedBlocks(log: string): Generator<{ commit: string; file: string; text: string; lines: number[] }> {
  let commit = '';
  let file: string | null = null;
  let next = 0;
  let text: string[] = [];
  let lines: number[] = [];
  const flush = function* () {
    if (file && text.length) yield { commit, file, text: text.join('\n'), lines };
    text = [];
    lines = [];
  };
  for (const raw of log.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('\x01')) {
      yield* flush();
      commit = line.slice(1).trim();
      file = null;
    } else if (line.startsWith('diff --git ')) {
      yield* flush();
      file = null;
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file && skipFile(file)) file = null;
    } else if (line.startsWith('@@')) {
      next = Number(/\+(\d+)/.exec(line)?.[1] ?? 1);
    } else if (line.startsWith('+') && file) {
      text.push(line.slice(1));
      lines.push(next++);
    }
  }
  yield* flush();
}

export const HISTORY_COMMITS = 300;

export async function scanSecrets(root: string, o: { commits?: number } = {}): Promise<{ items: ScanItem[]; stats: SecurityScanStats; historyRead: boolean }> {
  const notes: string[] = [];
  const files = (await git.trackedFiles(root)).filter((f) => !skipFile(f));
  const hits: SecretHit[] = [];
  const envFiles: Array<{ file: string; secret: string[]; other: string[] }> = [];
  let read = 0;
  let tooBig = 0;
  for (const file of files) {
    const full = path.join(root, file);
    let text: string;
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) {
        tooBig++;
        continue;
      }
      text = await fs.readFile(full, 'utf8');
    } catch {
      continue; // deleted in the working tree, or unreadable
    }
    if (text.slice(0, 8000).includes('\0')) continue;
    read++;
    hits.push(...scanText(text, file));
    if (isEnvFile(file)) envFiles.push({ file, ...envFileKeys(text) });
  }
  if (tooBig) notes.push(`${tooBig} file${tooBig === 1 ? ' was' : 's were'} skipped for being over 1.5 MB.`);

  let commits = 0;
  let historyRead = false;
  try {
    const { log, count } = await git.recentPatches(root, o.commits ?? HISTORY_COMMITS);
    commits = count;
    for (const b of addedBlocks(log)) hits.push(...scanText(b.text, b.file, b.commit, (n) => b.lines[n - 1] ?? n));
    historyRead = true;
  } catch (err) {
    notes.push(`The git history could not be read (${(err as Error).message.slice(0, 160)}), so only the current files were checked.`);
  }
  return { items: secretItems(hits, envFiles), stats: { files: read, commits, notes }, historyRead };
}
