// Resolves how to spawn the t3 CLI on this OS (spec §11.2, "Spawning the CLI").
//
// On Windows `t3.cmd` cannot be spawned without a shell (CVE-2024-27980), and a shell plus user
// text is an injection risk. So we read the .cmd, pull out the Electron exe + bin.mjs it runs,
// and spawn the exe directly with the same env. If parsing fails we fall back to cmd.exe, but
// then only accept arguments that match a strict allow-list.
import fs from 'node:fs';
import path from 'node:path';

export interface Launcher {
  kind: 'direct' | 'cmd';
  command: string;
  prefixArgs: string[];
  env: Record<string, string>;
  /** The CLI entry the user sees (t3.cmd path or `t3`). */
  cliPath: string;
}

/** Arguments accepted in cmd.exe fallback mode: ids, slugs, refs, and paths without cmd metacharacters. */
export const SAFE_ARG = /^[A-Za-z0-9._\-/:\\ ]+$/;

export interface ParsedCmd {
  exe: string;
  entry: string;
  env: Record<string, string>;
  /** Variables only set when not already defined (`if not defined X set "X=…"`). */
  defaultEnv: Record<string, string>;
}

export function parseT3Cmd(content: string): ParsedCmd | null {
  const env: Record<string, string> = {};
  const defaultEnv: Record<string, string> = {};
  let exe: string | null = null;
  let entry: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const cond = /^if\s+not\s+defined\s+(\w+)\s+set\s+"(\w+)=(.*)"$/i.exec(line);
    if (cond) {
      if (cond[1] === cond[2]) defaultEnv[cond[2]!] = cond[3]!;
      continue;
    }
    const set = /^set\s+"(\w+)=(.*)"$/i.exec(line);
    if (set) {
      env[set[1]!] = set[2]!;
      continue;
    }
    const run = /^"([^"]+\.exe)"\s+"([^"]+\.[cm]?js)"\s+%\*$/i.exec(line);
    if (run) {
      exe = run[1]!;
      entry = run[2]!;
    }
  }
  if (!exe || !entry) return null;
  return { exe, entry, env, defaultEnv };
}

export function defaultCliPath(t3Home: string): string {
  return process.platform === 'win32' ? path.join(t3Home, 'bin', 't3.cmd') : 't3';
}

export function resolveLauncher(o: { t3Home: string; cliPath?: string | null }): Launcher {
  const cliPath = o.cliPath || defaultCliPath(o.t3Home);

  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(cliPath)) {
    return { kind: 'direct', command: cliPath, prefixArgs: [], env: {}, cliPath };
  }

  if (!fs.existsSync(cliPath)) {
    const err = new Error(`t3 CLI not found at ${cliPath}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }

  const parsed = parseT3Cmd(fs.readFileSync(cliPath, 'utf8'));
  if (parsed && fs.existsSync(parsed.exe)) {
    const env: Record<string, string> = { ...parsed.env };
    for (const [k, v] of Object.entries(parsed.defaultEnv)) env[k] = process.env[k] ?? v;
    env.ELECTRON_RUN_AS_NODE = '1';
    env.T3CODE_CLI_PATH ??= cliPath;
    env.T3CODE_HOME ??= process.env.T3CODE_HOME ?? o.t3Home;
    return { kind: 'direct', command: parsed.exe, prefixArgs: [parsed.entry], env, cliPath };
  }

  return { kind: 'cmd', command: 'cmd.exe', prefixArgs: ['/d', '/s', '/c', cliPath], env: {}, cliPath };
}

/** Builds the final argv. In cmd mode every argument must pass SAFE_ARG and is quoted if it has spaces. */
export function buildArgs(launcher: Launcher, args: string[]): string[] {
  if (launcher.kind === 'direct') return [...launcher.prefixArgs, ...args];
  for (const a of args) {
    if (!SAFE_ARG.test(a)) throw new Error(`refusing to pass argument through cmd.exe: ${JSON.stringify(a)}`);
  }
  const quoted = [launcher.cliPath, ...args].map((a) => (a.includes(' ') ? `"${a}"` : a));
  // `/s /c` strips the outer quotes, so wrap the whole command line once more.
  return ['/d', '/s', '/c', `"${quoted.join(' ')}"`];
}
