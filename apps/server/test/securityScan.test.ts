import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { securityFindings, securityScans } from '../src/db/schema.ts';
import { compareVersions, cvss3Score, fixedVersionFor, vulnSeverity } from '../src/security/dependencies.ts';
import {
  collectPackages,
  parseBunLock,
  parseGemfileLock,
  parseGoMod,
  parseNpmLock,
  parsePnpmLock,
  parsePubspecLock,
  parseRequirements,
  parseYarnLock,
  lockfileParser,
} from '../src/security/lockfiles.ts';
import { addedBlocks, envFileKeys, isEnvFile, scanText } from '../src/security/secrets.ts';
import { beginScan, boardSecurity, dismissFinding } from '../src/security/service.ts';
import { setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

// Fake secrets are put together at runtime, so no literal token sits in this file.
const GH = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
const SLACK = ['xoxb', '1234567890', 'abcdefghijKLMNOP'].join('-');
const AWS_ID = ['AK', 'IA', 'Q3EGWNZ7XKPLM2RT'].join('');
const jwt = (payload: object) =>
  [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from(JSON.stringify(payload)).toString('base64url'), 'c2lnbmF0dXJlc2lnbmF0dXJl'].join('.');

async function commitAll(repo: string, message: string) {
  const g = (...a: string[]) => execa('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  await g('add', '-A');
  await g('commit', '-m', message);
}
const write = (repo: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const findings = () => h.db.select().from(securityFindings).all();
async function scan(kind: 'secrets' | 'dependencies') {
  const { scan, done } = await beginScan(h.ctx, h.board.id, kind);
  await done;
  return h.db.select().from(securityScans).where(eq(securityScans.id, scan.id)).get()!;
}

describe('secret rules', () => {
  it('finds tokens and keys, skips placeholders, documented examples and public keys', () => {
    const text = [
      `const token = "${GH}";`,
      'const docs = "AKIAIOSFODNN7EXAMPLE";',
      `const id = "${AWS_ID}";`,
      'const apiKey = "your-api-key-here-1234";',
      'const API_KEY = "x9Fk2LmQ8vRt3ZpW7nYb";',
      `const anon = "${jwt({ role: 'anon' })}";`,
      `const service = "${jwt({ role: 'service_role' })}";`,
      'DATABASE_URL=postgres://app:s3cretPw9@db.internal.acme.io:5432/app',
      'LOCAL_URL=postgres://app:s3cretPw9@localhost:5432/app',
    ].join('\n');
    const hits = scanText(text, 'src/config.ts');
    expect(hits.map((h) => [h.ruleId, h.severity, h.line]).sort((a, b) => Number(a[2]) - Number(b[2]))).toEqual([
      ['github_token', 'critical', 1],
      ['aws_access_key', 'high', 3],
      ['generic_secret', 'medium', 5],
      ['jwt', 'critical', 7],
      ['connection_string', 'high', 8],
      ['connection_string', 'low', 9],
    ]);
    expect(hits.find((h) => h.ruleId === 'github_token')!.preview).toBe('ghp_A1… (40 characters)');
    expect(JSON.stringify(hits)).not.toContain(GH);
  });

  it('counts keys in tests one level lower, and reads env files and added lines of a log', () => {
    expect(scanText(`k = "${AWS_ID}"`, 'test/fixtures/keys.ts')[0]!.severity).toBe('medium');
    expect(isEnvFile('.env')).toBe(true);
    expect(isEnvFile('config/prod.env')).toBe(true);
    expect(isEnvFile('.env.example')).toBe(false);
    expect(envFileKeys('PORT=3000\nSTRIPE_SECRET_KEY="abc123def"\nEMPTY=\nAPI_KEY=changeme\n')).toEqual({ secret: ['STRIPE_SECRET_KEY'], other: ['PORT'] });
    const log = ['\x01abc123', 'diff --git a/a.ts b/a.ts', '+++ b/a.ts', '@@ -0,0 +7,2 @@', '+one', '+two', '\x01def456', '+++ b/pnpm-lock.yaml', '@@ -1 +1 @@', '+x'].join('\n');
    expect([...addedBlocks(log)]).toEqual([{ commit: 'abc123', file: 'a.ts', text: 'one\ntwo', lines: [7, 8] }]);
  });
});

describe('secret scan', () => {
  it('reports current secrets, committed env files and secrets left in the history; a rescan fixes what is gone', async () => {
    h = await setup();
    write(h.repo, 'old.ts', `export const slack = "${SLACK}";\n`);
    await commitAll(h.repo, 'add slack');
    fs.rmSync(path.join(h.repo, 'old.ts'));
    write(h.repo, 'src/config.ts', `// config\nexport const token = "${GH}";\n`);
    write(h.repo, '.env', 'PORT=3000\nSTRIPE_SECRET_KEY=abc123def456\n');
    await commitAll(h.repo, 'config');

    const s1 = await scan('secrets');
    expect(s1).toMatchObject({ status: 'done', newCount: 3, fixedCount: 0 });
    expect(s1.stats).toMatchObject({ commits: 3 });
    const byTitle = Object.fromEntries(findings().map((f) => [f.title, f]));
    expect(byTitle['GitHub token in src/config.ts']).toMatchObject({ severity: 'critical', line: 2, source: 'secrets', status: 'open', category: 'secrets' });
    expect(byTitle['Environment file committed: .env']).toMatchObject({ severity: 'high' });
    const history = byTitle['Slack token in the git history (old.ts)']!;
    expect(history.meta).toMatchObject({ kind: 'secret', inHistoryOnly: true });
    expect(JSON.stringify(findings())).not.toContain(GH);

    // The token moves out of the code; the history keeps it (a history finding), the env file goes too.
    write(h.repo, 'src/config.ts', 'export const token = process.env.GH_TOKEN;\n');
    fs.rmSync(path.join(h.repo, '.env'));
    await commitAll(h.repo, 'clean up');
    dismissFinding(h.ctx, history.id, { reason: 'accepted_risk', note: 'rotated', undo: false });
    const s2 = await scan('secrets');
    expect(s2).toMatchObject({ status: 'done', newCount: 0, fixedCount: 1 });
    const after = Object.fromEntries(findings().map((f) => [f.fingerprint, f]));
    const gh = findings().find((f) => f.title.startsWith('GitHub token'))!;
    expect(gh).toMatchObject({ status: 'open', title: 'GitHub token in the git history (src/config.ts)' });
    expect(after[history.fingerprint]).toMatchObject({ status: 'dismissed', dismissReason: 'accepted_risk' });
    expect(findings().find((f) => f.title.includes('.env'))).toMatchObject({ status: 'fixed', resolvedBy: 'scan' });
    expect((await boardSecurity(h.ctx, h.board.id)).scans.map((s) => s.kind)).toEqual(['secrets', 'secrets']);
  });

  it('refuses a second scan of the same kind while one runs', async () => {
    h = await setup();
    const first = await beginScan(h.ctx, h.board.id, 'secrets');
    await expect(beginScan(h.ctx, h.board.id, 'secrets')).rejects.toThrow(/already running/);
    await first.done;
  });
});

describe('lockfiles', () => {
  it('reads npm, pnpm, yarn and bun lockfiles', () => {
    expect(
      parseNpmLock(
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { name: 'app', version: '1.0.0' },
            'node_modules/lodash': { version: '4.17.15' },
            'node_modules/a/node_modules/@scope/b': { version: '2.0.0' },
            'node_modules/alias': { name: 'real-name', version: '1.1.0' },
            'node_modules/linked': { link: true },
            'packages/web': { version: '0.0.1' },
          },
        }),
      ),
    ).toEqual([
      { ecosystem: 'npm', name: 'lodash', version: '4.17.15' },
      { ecosystem: 'npm', name: '@scope/b', version: '2.0.0' },
      { ecosystem: 'npm', name: 'real-name', version: '1.1.0' },
    ]);
    expect(parseNpmLock(JSON.stringify({ dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } } })).map((p) => p.name)).toEqual(['a', 'b']);

    const v9 = "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      x: 1\n\npackages:\n\n  '@babel/core@7.22.0':\n    resolution: {integrity: sha512-x}\n\n  react-dom@18.2.0(react@18.2.0):\n    resolution: {}\n\nsnapshots:\n\n  zod@3.0.0:\n    resolution: {}\n";
    expect(parsePnpmLock(v9)).toEqual([
      { ecosystem: 'npm', name: '@babel/core', version: '7.22.0' },
      { ecosystem: 'npm', name: 'react-dom', version: '18.2.0' },
    ]);
    const v6 = "lockfileVersion: '6.0'\npackages:\n  /@babel/core@7.22.0:\n    resolution: {}\n  /react-dom@18.2.0(react@18.2.0):\n    dev: false\n";
    expect(parsePnpmLock(v6).map((p) => `${p.name}@${p.version}`)).toEqual(['@babel/core@7.22.0', 'react-dom@18.2.0']);
    const v5 = 'lockfileVersion: 5.4\npackages:\n  /@babel/core/7.22.0:\n    resolution: {}\n  /react-dom/18.2.0_react@18.2.0:\n    dev: false\n';
    expect(parsePnpmLock(v5).map((p) => `${p.name}@${p.version}`)).toEqual(['@babel/core@7.22.0', 'react-dom@18.2.0']);

    const yarn1 = '# yarn lockfile v1\n\n"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":\n  version "7.12.13"\n  resolved "x"\n\nlodash@^4.17.15:\n  version "4.17.15"\n';
    expect(parseYarnLock(yarn1).map((p) => `${p.name}@${p.version}`)).toEqual(['@babel/code-frame@7.12.13', 'lodash@4.17.15']);
    const berry = '__metadata:\n  version: 6\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n\n"lodash@npm:^4.17.15":\n  version: 4.17.21\n  resolution: "lodash@npm:4.17.21"\n';
    expect(parseYarnLock(berry)).toEqual([{ ecosystem: 'npm', name: 'lodash', version: '4.17.21' }]);
    expect(parseBunLock('{\n  "packages": {\n    "zod": ["zod@3.23.8", "", {}, "sha"],\n    "@types/node": ["@types/node@20.1.0", "", {}, "sha"],\n    "app": ["app@workspace:."]\n  }\n}')).toEqual([
      { ecosystem: 'npm', name: 'zod', version: '3.23.8' },
      { ecosystem: 'npm', name: '@types/node', version: '20.1.0' },
    ]);
  });

  it('reads Python, Rust, Go, Ruby and Dart lockfiles', () => {
    expect(parseRequirements('Django==3.2.0\nrequests[socks]>=2\nFlask_Login == 0.6.2 ; python_version > "3"\n# c\n-e .\n')).toEqual([
      { ecosystem: 'PyPI', name: 'django', version: '3.2.0' },
      { ecosystem: 'PyPI', name: 'flask-login', version: '0.6.2' },
    ]);
    const uv = '[[package]]\nname = "anyio"\nversion = "4.4.0"\nsource = { registry = "https://pypi.org/simple" }\ndependencies = [\n    { name = "idna" },\n]\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n';
    expect(lockfileParser('uv.lock')!(uv)).toEqual([{ ecosystem: 'PyPI', name: 'anyio', version: '4.4.0' }]);
    const cargo = '[[package]]\nname = "app"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.100"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n';
    expect(lockfileParser('crates/x/Cargo.lock')!(cargo)).toEqual([{ ecosystem: 'crates.io', name: 'serde', version: '1.0.100' }]);
    expect(parseGoMod('module x\n\ngo 1.22\n\nrequire github.com/a/b v1.2.3\n\nrequire (\n\tgolang.org/x/net v0.17.0 // indirect\n)\n')).toEqual([
      { ecosystem: 'Go', name: 'github.com/a/b', version: '1.2.3' },
      { ecosystem: 'Go', name: 'golang.org/x/net', version: '0.17.0' },
    ]);
    expect(parseGemfileLock('GEM\n  remote: https://rubygems.org/\n  specs:\n    nokogiri (1.15.4-x86_64-linux)\n      racc (~> 1.4)\n    rails (7.0.4)\n\nPLATFORMS\n  ruby\n')).toEqual([
      { ecosystem: 'RubyGems', name: 'nokogiri', version: '1.15.4' },
      { ecosystem: 'RubyGems', name: 'rails', version: '7.0.4' },
    ]);
    expect(parsePubspecLock('packages:\n  http:\n    dependency: "direct main"\n    source: hosted\n    version: "1.1.0"\n  mine:\n    source: path\n    version: "0.0.1"\nsdks:\n  dart: ">=3.0.0"\n')).toEqual([
      { ecosystem: 'Pub', name: 'http', version: '1.1.0' },
    ]);
    expect(lockfileParser('node_modules/x/package-lock.json')).toBeNull();
    const { packages, errors } = collectPackages([
      { file: 'a/requirements.txt', text: 'django==3.2.0\n' },
      { file: 'b/requirements-dev.txt', text: 'Django==3.2.0\n' },
      { file: 'c/package-lock.json', text: '{ not json' },
    ]);
    expect(packages).toEqual([{ ecosystem: 'PyPI', name: 'django', version: '3.2.0', lockfiles: ['a/requirements.txt', 'b/requirements-dev.txt'] }]);
    expect(errors[0]).toMatch(/^c\/package-lock\.json: /);
  });
});

describe('advisories', () => {
  it('scores CVSS 3 vectors and orders versions', () => {
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1);
    expect(cvss3Score('CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N')).toBe(5.5);
    expect(cvss3Score('CVSS:4.0/AV:N')).toBeNull();
    expect(vulnSeverity({ id: 'x', database_specific: { severity: 'MODERATE' } })).toBe('medium');
    expect(vulnSeverity({ id: 'x', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] })).toBe('critical');
    expect(vulnSeverity({ id: 'x' })).toBe('medium');
    expect(['1.10.0', '1.2.0', '1.2.0-rc.1', 'v1.9.9'].sort(compareVersions)).toEqual(['1.2.0-rc.1', '1.2.0', 'v1.9.9', '1.10.0']);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    const v = {
      id: 'GHSA-1',
      affected: [
        { package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] },
        { package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '3.0.0' }, { fixed: '3.10.2' }] }] },
      ],
    };
    expect(fixedVersionFor(v, { ecosystem: 'npm', name: 'lodash', version: '4.17.15' })).toBe('4.17.21');
    expect(fixedVersionFor(v, { ecosystem: 'npm', name: 'lodash', version: '3.1.0' })).toBe('3.10.2');
    expect(fixedVersionFor(v, { ecosystem: 'npm', name: 'other', version: '1.0.0' })).toBeNull();
  });
});

describe('dependency scan', () => {
  /** OSV.dev stand-in: `vulns` maps "name@version" to advisory ids; `details` holds the advisories. */
  function osv(vulns: Record<string, string[]>, details: Record<string, object>) {
    const calls: string[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith('/querybatch')) {
        const { queries } = JSON.parse(String(init!.body)) as { queries: Array<{ package: { name: string }; version: string }> };
        return Response.json({ results: queries.map((q) => ({ vulns: (vulns[`${q.package.name}@${q.version}`] ?? []).map((id) => ({ id, modified: 'x' })) })) });
      }
      const id = decodeURIComponent(String(url).split('/vulns/')[1]!);
      return details[id] ? Response.json(details[id]) : new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { fn, calls };
  }
  const lock = (versions: Record<string, string>) =>
    JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(Object.entries(versions).map(([n, v]) => [`node_modules/${n}`, { version: v }])) });
  const advisory = (id: string, name: string, fixed: string, o: object = {}) => ({
    id,
    summary: `${id} summary`,
    affected: [{ package: { ecosystem: name === 'django' ? 'PyPI' : 'npm', name }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed }] }] }],
    ...o,
  });

  it('turns OSV advisories into one finding per package, fixes them when the lockfile moves on, and reopens a dismissed one on a new advisory', async () => {
    h = await setup();
    write(h.repo, 'package-lock.json', lock({ lodash: '4.17.15', minimist: '1.2.8' }));
    write(h.repo, 'api/requirements.txt', 'django==3.2.0\n');
    await commitAll(h.repo, 'deps');
    const details = {
      'GHSA-aaaa': advisory('GHSA-aaaa', 'lodash', '4.17.19', { database_specific: { severity: 'HIGH' }, aliases: ['CVE-2020-1'] }),
      'GHSA-bbbb': advisory('GHSA-bbbb', 'lodash', '4.17.21', { database_specific: { severity: 'CRITICAL' } }),
      'GHSA-dddd': advisory('GHSA-dddd', 'django', '3.2.5', { database_specific: { severity: 'MODERATE' }, aliases: ['CVE-2021-9'] }),
      'PYSEC-2021-1': advisory('PYSEC-2021-1', 'django', '3.2.5', { aliases: ['CVE-2021-9'] }),
    };
    const o = osv({ 'lodash@4.17.15': ['GHSA-aaaa', 'GHSA-bbbb'], 'django@3.2.0': ['PYSEC-2021-1', 'GHSA-dddd'] }, details);
    h.ctx.fetch = o.fn;

    const s1 = await scan('dependencies');
    expect(s1).toMatchObject({ status: 'done', newCount: 2 });
    expect(s1.stats).toMatchObject({ packages: 3, vulnerable: 2, ecosystems: ['PyPI', 'npm'], lockfiles: ['api/requirements.txt', 'package-lock.json'] });
    const lodash = findings().find((f) => f.fingerprint === 'dep:npm:lodash')!;
    expect(lodash).toMatchObject({ severity: 'critical', category: 'dependencies', file: 'package-lock.json', title: 'lodash 4.17.15 has 2 known vulnerabilities' });
    expect(lodash.meta).toMatchObject({ kind: 'dependency', fixedIn: '4.17.21', versions: ['4.17.15'] });
    expect(lodash.touches).toEqual(['package-lock.json', 'package.json']);
    const django = findings().find((f) => f.fingerprint === 'dep:PyPI:django')!;
    // PYSEC-2021-1 is the same issue as GHSA-dddd (shared CVE): one advisory, GitHub's severity.
    expect(django.meta.kind === 'dependency' && django.meta.advisories.map((a) => [a.id, a.severity, a.fixed])).toEqual([['GHSA-dddd', 'medium', '3.2.5']]);
    expect(django.title).toBe('django 3.2.0: GHSA-dddd summary');

    dismissFinding(h.ctx, django.id, { reason: 'wont_fix', note: '', undo: false });
    write(h.repo, 'package-lock.json', lock({ lodash: '4.17.21', minimist: '1.2.8' }));
    await commitAll(h.repo, 'bump lodash');
    h.ctx.fetch = osv({ 'django@3.2.0': ['GHSA-dddd', 'GHSA-eeee'] }, { ...details, 'GHSA-eeee': advisory('GHSA-eeee', 'django', '3.2.9', { database_specific: { severity: 'HIGH' } }) }).fn;
    const s2 = await scan('dependencies');
    expect(s2).toMatchObject({ status: 'done', newCount: 1, fixedCount: 1 });
    expect(findings().find((f) => f.id === lodash.id)).toMatchObject({ status: 'fixed', resolvedBy: 'scan' });
    expect(findings().find((f) => f.id === django.id)).toMatchObject({ status: 'open', dismissReason: null, severity: 'high' });
  });

  it('fails the scan, not the server, when OSV.dev is unreachable', async () => {
    h = await setup();
    write(h.repo, 'requirements.txt', 'django==3.2.0\n');
    await commitAll(h.repo, 'deps');
    h.ctx.fetch = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.osv.dev');
    }) as typeof fetch;
    const s = await scan('dependencies');
    expect(s).toMatchObject({ status: 'failed', error: expect.stringMatching(/Could not reach OSV\.dev/) });
    expect(findings()).toEqual([]);
  });
});
