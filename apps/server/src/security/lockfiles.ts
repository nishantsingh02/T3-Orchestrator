// Lockfile readers for the dependency scan: the exact package versions a project installs, per
// ecosystem (named the way OSV.dev names them). Line-based where the format allows, so no YAML or
// TOML parser is needed; anything unreadable is skipped rather than guessed.
import path from 'node:path';

export interface LockedPackage {
  ecosystem: string;
  name: string;
  version: string;
}

type Parser = (text: string) => LockedPackage[];

const looksVersion = (v: string | undefined): v is string => !!v && /^\d/.test(v);

/** package-lock.json / npm-shrinkwrap.json, lockfile v1 to v3. */
export function parseNpmLock(text: string): LockedPackage[] {
  const json = JSON.parse(text) as {
    packages?: Record<string, { name?: string; version?: string; link?: boolean }>;
    dependencies?: Record<string, NpmV1Dep>;
  };
  const out: LockedPackage[] = [];
  if (json.packages) {
    for (const [key, p] of Object.entries(json.packages)) {
      // "" is the project itself; workspace folders have no node_modules/ in their key.
      const at = key.lastIndexOf('node_modules/');
      if (at === -1 || p.link || !looksVersion(p.version)) continue;
      out.push({ ecosystem: 'npm', name: p.name ?? key.slice(at + 'node_modules/'.length), version: p.version });
    }
    return out;
  }
  const walk = (deps: Record<string, NpmV1Dep> | undefined) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      if (looksVersion(d.version)) out.push({ ecosystem: 'npm', name, version: d.version });
      walk(d.dependencies);
    }
  };
  walk(json.dependencies);
  return out;
}
interface NpmV1Dep {
  version?: string;
  dependencies?: Record<string, NpmV1Dep>;
}

/** pnpm-lock.yaml v5 (`/name/1.0.0`), v6 (`/name@1.0.0`) and v9 (`name@1.0.0`), with peer suffixes. */
export function parsePnpmLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  // v5 keys are paths (`/@scope/name/1.0.0_peer@1.0.0`); later ones are `name@version(peer@1.0.0)`.
  const v5 = /^lockfileVersion:\s*['"]?5/m.test(text);
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\S/.test(raw)) {
      inPackages = raw.trimEnd() === 'packages:';
      continue;
    }
    if (!inPackages) continue;
    const m = /^ {2}(['"]?)([^'"\s][^'"]*?)\1:\s*$/.exec(raw);
    if (!m) continue;
    let key = m[2]!.replace(/^\//, '');
    const paren = key.indexOf('(');
    if (paren > 0) key = key.slice(0, paren);
    const cut = v5 ? key.lastIndexOf('/') : key.lastIndexOf('@');
    if (cut <= 0) continue;
    const name = key.slice(0, cut);
    const version = key.slice(cut + 1).split('_')[0]!;
    if (looksVersion(version) && !name.includes(':')) out.push({ ecosystem: 'npm', name, version });
  }
  return out;
}

/** yarn.lock, classic (v1) and berry. */
export function parseYarnLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let name: string | null = null;
  let skip = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^[^\s#]/.test(raw) && raw.trimEnd().endsWith(':')) {
      const first = raw.trimEnd().slice(0, -1).split(/,\s*/)[0]!.replace(/^"|"$/g, '');
      const at = first.lastIndexOf('@');
      name = at > 0 ? first.slice(0, at).replace(/@npm$/, '') : null;
      // Berry writes "name@npm:range"; the npm: protocol is part of the range.
      const npmAt = first.indexOf('@npm:');
      if (npmAt > 0) name = first.slice(0, npmAt);
      skip = /@(workspace|link|portal|file):/.test(first) || name === '__metadata';
      continue;
    }
    if (!name || skip) continue;
    const res = /^\s+resolution:\s*"?(.+?)@npm:([^"]+)"?\s*$/.exec(raw);
    if (res) {
      name = res[1]!;
      continue;
    }
    const v = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(raw);
    if (v && looksVersion(v[1])) {
      out.push({ ecosystem: 'npm', name, version: v[1] });
      name = null;
    }
  }
  return out;
}

/** bun.lock (the text format of Bun 1.2+). */
export function parseBunLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const m of text.matchAll(/^\s*"[^"]+":\s*\[\s*"((?:@[^@"/]+\/)?[^@"]+)@([^"]+)"/gm)) {
    if (looksVersion(m[2])) out.push({ ecosystem: 'npm', name: m[1]!, version: m[2] });
  }
  return out;
}

/** PEP 503 name: lowercase, runs of -_. as one dash. */
export const pypiName = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-');

/** requirements*.txt: only exact pins (==) say what is installed. */
export function parseRequirements(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([0-9][^\s;#,\\]*)/.exec(raw);
    if (m) out.push({ ecosystem: 'PyPI', name: pypiName(m[1]!), version: m[2]! });
  }
  return out;
}

/** `[[package]]` tables with name/version lines: poetry.lock, uv.lock, pdm.lock and Cargo.lock. */
function parseTomlPackages(text: string, ecosystem: string, o: { requireRegistry?: boolean } = {}): LockedPackage[] {
  const out: LockedPackage[] = [];
  let cur: { name?: string; version?: string; local?: boolean; registry?: boolean } | null = null;
  let inTable = false;
  const push = () => {
    if (cur?.name && looksVersion(cur.version) && !cur.local && (!o.requireRegistry || cur.registry)) {
      out.push({ ecosystem, name: ecosystem === 'PyPI' ? pypiName(cur.name) : cur.name, version: cur.version });
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('[[package]]')) {
      push();
      cur = {};
      inTable = true;
      continue;
    }
    if (raw.startsWith('[')) {
      inTable = false;
      continue;
    }
    if (!cur || !inTable) continue;
    const m = /^(name|version|source)\s*=\s*(.+)$/.exec(raw);
    if (!m) continue;
    const value = m[2]!.trim();
    if (m[1] === 'source') {
      cur.registry = /registry/.test(value);
      cur.local = /\b(editable|virtual|directory|path)\s*=/.test(value);
    } else {
      cur[m[1] as 'name' | 'version'] = value.replace(/^"|"$/g, '');
    }
  }
  push();
  return out;
}

/** Pipfile.lock */
export function parsePipfileLock(text: string): LockedPackage[] {
  const json = JSON.parse(text) as Record<string, Record<string, { version?: string }> | undefined>;
  const out: LockedPackage[] = [];
  for (const section of ['default', 'develop']) {
    for (const [name, p] of Object.entries(json[section] ?? {})) {
      const version = p.version?.replace(/^==/, '');
      if (looksVersion(version)) out.push({ ecosystem: 'PyPI', name: pypiName(name), version });
    }
  }
  return out;
}

/** go.mod `require` lines (go.sum also lists versions that aren't built). */
export function parseGoMod(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const m = (inBlock ? /^(\S+)\s+v(\S+)$/ : /^require\s+(\S+)\s+v(\S+)$/).exec(line);
    if (m && looksVersion(m[2])) out.push({ ecosystem: 'Go', name: m[1]!, version: m[2]! });
  }
  return out;
}

/** Gemfile.lock: the gems under GEM > specs (four spaces; six are their dependencies). */
export function parseGemfileLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let inSpecs = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\S/.test(raw)) {
      inSpecs = false;
      continue;
    }
    if (raw.trim() === 'specs:') {
      inSpecs = true;
      continue;
    }
    if (!inSpecs) continue;
    const m = /^ {4}([^\s(]+) \(([^)]+)\)$/.exec(raw);
    if (m) {
      // Platform gems: 1.15.4-x86_64-linux.
      const version = m[2]!.split('-')[0]!;
      if (looksVersion(version)) out.push({ ecosystem: 'RubyGems', name: m[1]!, version });
    }
  }
  return out;
}

/** composer.lock */
export function parseComposerLock(text: string): LockedPackage[] {
  const json = JSON.parse(text) as Record<string, Array<{ name?: string; version?: string }> | undefined>;
  const out: LockedPackage[] = [];
  for (const p of [...(json.packages ?? []), ...(json['packages-dev'] ?? [])]) {
    const version = p.version?.replace(/^v/, '');
    if (p.name && looksVersion(version)) out.push({ ecosystem: 'Packagist', name: p.name, version });
  }
  return out;
}

/** NuGet packages.lock.json */
export function parseNugetLock(text: string): LockedPackage[] {
  const json = JSON.parse(text) as { dependencies?: Record<string, Record<string, { type?: string; resolved?: string }>> };
  const out: LockedPackage[] = [];
  for (const framework of Object.values(json.dependencies ?? {})) {
    for (const [name, p] of Object.entries(framework)) {
      if (p.type !== 'Project' && looksVersion(p.resolved)) out.push({ ecosystem: 'NuGet', name, version: p.resolved });
    }
  }
  return out;
}

/** pubspec.lock: hosted packages only. */
export function parsePubspecLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let inPackages = false;
  let cur: { name: string; hosted?: boolean; version?: string } | null = null;
  const push = () => {
    if (cur?.hosted && looksVersion(cur.version)) out.push({ ecosystem: 'Pub', name: cur.name, version: cur.version });
  };
  for (const raw of text.split(/\r?\n/)) {
    if (/^\S/.test(raw)) {
      push();
      cur = null;
      inPackages = raw.trimEnd() === 'packages:';
      continue;
    }
    if (!inPackages) continue;
    const pkg = /^ {2}([^\s:]+):\s*$/.exec(raw);
    if (pkg) {
      push();
      cur = { name: pkg[1]!.replace(/^"|"$/g, '') };
      continue;
    }
    const field = /^ {4}(source|version):\s*"?([^"\s]+)"?\s*$/.exec(raw);
    if (field && cur) {
      if (field[1] === 'source') cur.hosted = field[2] === 'hosted';
      else cur.version = field[2];
    }
  }
  push();
  return out;
}

/** gradle.lockfile: `group:artifact:version=configurations`. */
export function parseGradleLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const m of text.matchAll(/^([^#\s:=]+):([^\s:=]+):([^\s:=]+)=/gm)) {
    if (looksVersion(m[3])) out.push({ ecosystem: 'Maven', name: `${m[1]}:${m[2]}`, version: m[3] });
  }
  return out;
}

/** mix.lock (Elixir): hex packages. */
export function parseMixLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const m of text.matchAll(/^\s*"[^"]+":\s*\{:hex,\s*:"?([A-Za-z0-9_]+)"?,\s*"([^"]+)"/gm)) {
    if (looksVersion(m[2])) out.push({ ecosystem: 'Hex', name: m[1]!, version: m[2] });
  }
  return out;
}

const PARSERS: Record<string, Parser> = {
  'package-lock.json': parseNpmLock,
  'npm-shrinkwrap.json': parseNpmLock,
  'pnpm-lock.yaml': parsePnpmLock,
  'yarn.lock': parseYarnLock,
  'bun.lock': parseBunLock,
  'poetry.lock': (t) => parseTomlPackages(t, 'PyPI'),
  'uv.lock': (t) => parseTomlPackages(t, 'PyPI'),
  'pdm.lock': (t) => parseTomlPackages(t, 'PyPI'),
  'Pipfile.lock': parsePipfileLock,
  'Cargo.lock': (t) => parseTomlPackages(t, 'crates.io', { requireRegistry: true }),
  'go.mod': parseGoMod,
  'Gemfile.lock': parseGemfileLock,
  'composer.lock': parseComposerLock,
  'packages.lock.json': parseNugetLock,
  'pubspec.lock': parsePubspecLock,
  'gradle.lockfile': parseGradleLock,
  'mix.lock': parseMixLock,
};

/** The parser for a repo-relative path, when it is a lockfile this scan reads. */
export function lockfileParser(file: string): Parser | null {
  if (/(^|\/)(node_modules|vendor|\.git)\//.test(file)) return null;
  const base = path.posix.basename(file);
  if (PARSERS[base]) return PARSERS[base]!;
  if (/^requirements[\w.-]*\.txt$/i.test(base) || /^constraints[\w.-]*\.txt$/i.test(base)) return parseRequirements;
  return null;
}

/** Every package of every lockfile, once per ecosystem/name/version. */
export function collectPackages(files: Array<{ file: string; text: string }>): {
  packages: Array<LockedPackage & { lockfiles: string[] }>;
  errors: string[];
} {
  const byKey = new Map<string, LockedPackage & { lockfiles: string[] }>();
  const errors: string[] = [];
  for (const { file, text } of files) {
    const parse = lockfileParser(file);
    if (!parse) continue;
    let list: LockedPackage[];
    try {
      list = parse(text);
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message.slice(0, 120)}`);
      continue;
    }
    for (const p of list) {
      const key = `${p.ecosystem}|${p.name}|${p.version}`;
      const known = byKey.get(key);
      if (known) {
        if (!known.lockfiles.includes(file)) known.lockfiles.push(file);
      } else byKey.set(key, { ...p, lockfiles: [file] });
    }
  }
  return { packages: [...byKey.values()], errors };
}
