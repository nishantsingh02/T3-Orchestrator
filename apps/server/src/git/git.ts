// Git helpers (spec §13). execa with argument arrays only, never a shell.
import { execa } from 'execa';
import type { DiffFile, DiffStat } from '@t3-orchestra/shared';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr = '',
    readonly exitCode: number | undefined = undefined,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

async function git(cwd: string, args: string[], o: { allowFail?: boolean; timeoutMs?: number } = {}) {
  const r = await execa('git', ['-C', cwd, ...args], {
    reject: false,
    windowsHide: true,
    timeout: o.timeoutMs ?? 60_000,
    stripFinalNewline: true,
    maxBuffer: 128 * 1024 * 1024,
    env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    extendEnv: true,
  });
  if (r.failed && !o.allowFail) {
    throw new GitError(`git ${args[0]} failed: ${String(r.stderr || r.stdout || r.originalMessage).trim()}`, String(r.stderr ?? ''), r.exitCode);
  }
  return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode ?? -1, failed: r.failed };
}

export async function toplevel(p: string): Promise<string | null> {
  const r = await git(p, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return r.failed ? null : r.stdout.trim();
}

export async function currentBranch(p: string): Promise<string | null> {
  const r = await git(p, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true });
  return r.failed ? null : r.stdout.trim() || null;
}

export async function localBranches(p: string): Promise<string[]> {
  const r = await git(p, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { allowFail: true });
  return r.failed ? [] : r.stdout.split(/\r?\n/).filter(Boolean);
}

export async function refExists(p: string, ref: string): Promise<boolean> {
  const r = await git(p, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  return !r.failed;
}

export async function remoteUrl(p: string, remote: string): Promise<string | null> {
  const r = await git(p, ['remote', 'get-url', remote], { allowFail: true });
  return r.failed ? null : r.stdout.trim() || null;
}

/** Is `name` usable as a new branch name (`git check-ref-format --branch`)? */
export async function validBranchName(name: string): Promise<boolean> {
  const r = await execa('git', ['check-ref-format', '--branch', name], { reject: false, windowsHide: true });
  return !r.failed && !name.startsWith('-');
}

/** `git init` on `branch`, then a first commit of everything in the folder that .gitignore lets through. */
export async function initWithFirstCommit(dir: string, branch: string, message: string): Promise<void> {
  await git(dir, ['init', '--initial-branch', branch]);
  await git(dir, ['add', '--all'], { timeoutMs: 300_000 });
  await git(dir, ['commit', '--allow-empty', '-m', message], { timeoutMs: 120_000 });
}

export async function headSha(p: string, ref = 'HEAD'): Promise<string | null> {
  const r = await git(p, ['rev-parse', ref], { allowFail: true });
  return r.failed ? null : r.stdout.trim();
}

/** Uncommitted (incl. untracked) paths from `status --porcelain`. */
export async function uncommitted(p: string): Promise<string[]> {
  const r = await git(p, ['status', '--porcelain', '--untracked-files=all']);
  return r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3));
}

/** Tracked files of the checkout, repo-relative with forward slashes. */
export async function trackedFiles(p: string): Promise<string[]> {
  const r = await git(p, ['-c', 'core.quotepath=off', 'ls-files', '-z']);
  return r.stdout.split('\0').filter(Boolean);
}

/** Patches of the last `n` commits on HEAD (newest first, no context lines), each headed by "\x01<sha>". */
export async function recentPatches(p: string, n: number): Promise<{ log: string; count: number }> {
  const r = await git(p, ['-c', 'core.quotepath=off', 'log', `-n${n}`, '-p', '--no-color', '--no-ext-diff', '--unified=0', '--format=%x01%H', 'HEAD'], {
    timeoutMs: 120_000,
  });
  return { log: r.stdout, count: (r.stdout.match(/^\x01/gm) ?? []).length };
}

/** Commits in `to` that `from` doesn't have; null when git can't tell (an unknown commit). */
export async function commitsBetween(p: string, from: string, to = 'HEAD'): Promise<number | null> {
  const r = await git(p, ['rev-list', '--count', `${from}..${to}`], { allowFail: true });
  const n = Number(r.stdout.trim());
  return r.failed || !Number.isFinite(n) ? null : n;
}

/** Uncommitted changes to tracked files only (untracked files don't block a merge). */
export async function trackedChanges(p: string): Promise<string[]> {
  const r = await git(p, ['status', '--porcelain', '--untracked-files=no']);
  return r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3));
}

/** Uncommitted paths under `rel` (untracked included), and whether .gitignore keeps any of it out. */
export async function pathState(p: string, rel: string): Promise<{ changes: number; ignored: boolean }> {
  const r = await git(p, ['status', '--porcelain', '--untracked-files=all', '--ignored', '--', rel]);
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  return { changes: lines.filter((l) => !l.startsWith('!!')).length, ignored: lines.some((l) => l.startsWith('!!')) };
}

export function parseNumstat(out: string): DiffFile[] {
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [a, r, ...rest] = line.split('\t');
      const binary = a === '-' || r === '-';
      return { path: rest.join('\t'), added: binary ? 0 : Number(a), removed: binary ? 0 : Number(r), binary };
    });
}

/** Files changed on the branch relative to its merge base with `base` (`base...HEAD`). */
export async function diffFiles(worktree: string, base: string): Promise<DiffFile[]> {
  const r = await git(worktree, ['diff', '--numstat', `${base}...HEAD`]);
  return parseNumstat(r.stdout);
}

export async function diffPatch(worktree: string, base: string): Promise<string> {
  const r = await git(worktree, ['diff', '--no-color', '--no-ext-diff', `${base}...HEAD`]);
  return r.stdout;
}

export function summarize(files: DiffFile[]): DiffStat {
  return files.reduce((s, f) => ({ added: s.added + f.added, removed: s.removed + f.removed, files: s.files + 1 }), {
    added: 0,
    removed: 0,
    files: 0,
  });
}

/** Commits on `branch` that `base` does not have. */
export async function aheadBy(root: string, base: string, branch: string): Promise<number> {
  const r = await git(root, ['rev-list', '--count', `${base}..${branch}`], { allowFail: true });
  return r.failed ? -1 : Number(r.stdout.trim()) || 0;
}

/** Commits on `base` that `branch` does not have. */
export async function behindBy(root: string, base: string, branch: string): Promise<number> {
  const r = await git(root, ['rev-list', '--count', `${branch}..${base}`], { allowFail: true });
  return r.failed ? 0 : Number(r.stdout.trim()) || 0;
}

export type MergeOutcome = { ok: true; sha: string } | { ok: false; conflict: true; files: string[] } | { ok: false; conflict: false; error: string };

/** `git merge --no-ff <branch> -m <msg>` in the root checkout; aborts on conflict. */
export async function mergeNoFf(root: string, branch: string, message: string): Promise<MergeOutcome> {
  const r = await git(root, ['-c', 'core.editor=true', 'merge', '--no-ff', '--no-edit', branch, '-m', message], { allowFail: true });
  if (!r.failed) return { ok: true, sha: (await headSha(root)) ?? '' };
  const conflicted = await git(root, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
  const files = conflicted.stdout.split(/\r?\n/).filter(Boolean);
  const merging = await refExists(root, 'MERGE_HEAD');
  if (merging || files.length) {
    await git(root, ['merge', '--abort'], { allowFail: true });
    return { ok: false, conflict: true, files };
  }
  return { ok: false, conflict: false, error: (r.stderr || r.stdout).trim() };
}
