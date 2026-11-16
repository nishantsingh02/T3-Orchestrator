// GitHub through the user's own `gh` CLI: who it is signed in as, and a private repo for a new project.
import type { GithubAccountView } from '@t3-orchestra/shared';
import { execa } from 'execa';
import { onPath } from '../project-run/system.ts';

const ACCOUNT_TTL_MS = 60_000;

async function gh(args: string[], timeoutMs = 20_000) {
  const r = await execa('gh', args, {
    reject: false,
    windowsHide: true,
    timeout: timeoutMs,
    stripFinalNewline: true,
    env: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    extendEnv: true,
  });
  return { ok: !r.failed, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '').trim() || String(r.originalMessage ?? '') };
}

let cached: { at: number; value: Promise<GithubAccountView> } | null = null;

async function readAccount(): Promise<GithubAccountView> {
  if (!onPath('gh')) {
    return { ok: false, login: null, owners: [], error: 'The GitHub CLI (gh) is not installed. Install it from cli.github.com, then run "gh auth login".' };
  }
  const user = await gh(['api', 'user', '--jq', '.login']);
  const login = user.stdout.trim();
  if (!user.ok || !login) {
    return { ok: false, login: null, owners: [], error: `gh is not signed in to GitHub. Run "gh auth login" first. ${user.stderr}`.trim() };
  }
  const orgs = await gh(['api', 'user/orgs', '--jq', '.[].login']);
  const owners = [login, ...(orgs.ok ? orgs.stdout.split(/\r?\n/).map((o) => o.trim()).filter(Boolean) : [])];
  return { ok: true, login, owners, error: null };
}

/** gh's signed-in account and its organizations, cached for a minute. */
export function githubAccount(refresh = false): Promise<GithubAccountView> {
  if (!refresh && cached && Date.now() - cached.at < ACCOUNT_TTL_MS) return cached.value;
  const entry = { at: Date.now(), value: readAccount() };
  cached = entry;
  return entry.value;
}

/**
 * `gh repo create owner/name --private` for the git repository in `dir`: adds it as `origin` and pushes
 * the current branch. Resolves with the repo's web URL.
 */
export async function createPrivateRepo(dir: string, owner: string, name: string): Promise<string> {
  const r = await gh(['repo', 'create', `${owner}/${name}`, '--private', '--source', dir, '--remote', 'origin', '--push'], 180_000);
  if (!r.ok) throw new Error(r.stderr || 'gh repo create failed');
  return /https:\/\/github\.com\/\S+/.exec(`${r.stdout}\n${r.stderr}`)?.[0]?.replace(/\.git$/, '') ?? `https://github.com/${owner}/${name}`;
}
