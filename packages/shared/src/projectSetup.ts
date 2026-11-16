// New board → project setup: a folder chosen in the OS's folder window or made new, `git init` on a chosen
// branch, and a private GitHub repo through the user's own `gh` CLI.
import { z } from 'zod';
import type { ProjectValidation } from './views.ts';

/** POST /api/folders/pick: opens the OS's folder window on the computer T3 Orchestra runs on. */
export const PickFolderBody = z.object({
  title: z.string().trim().max(200).optional(),
  /** Where the window starts; ignored when it doesn't exist. */
  startIn: z.string().trim().max(1000).optional(),
});
export type PickFolderBody = z.infer<typeof PickFolderBody>;

/** `path` is null when the user closed the window without choosing. */
export interface PickFolderResult {
  path: string | null;
}

/** POST /api/folders/check-new: may `name` be made inside `parent`? */
export const CheckNewFolderBody = z.object({
  parent: z.string().trim().min(1).max(1000),
  name: z.string().max(255),
});
export type CheckNewFolderBody = z.infer<typeof CheckNewFolderBody>;

export interface NewFolderCheck {
  /** The folder that would be made (absolute), when the parent and name are usable. */
  path: string | null;
  error: string | null;
}

export const GithubRepoTarget = z.object({
  owner: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
});
export type GithubRepoTarget = z.infer<typeof GithubRepoTarget>;

/** POST /api/projects/setup. Each step runs only when asked for, in this order; T3 Code learns the project last. */
export const SetupProjectBody = z.object({
  projectPath: z.string().trim().min(1).max(1000),
  /** Make the folder first; its parent must exist and the folder must not. */
  createFolder: z.boolean().optional(),
  /** `git init` on this branch with a first commit, when the folder isn't in a git repository (always for a new folder). */
  initBranch: z.string().trim().min(1).max(100).optional(),
  /** Create a private GitHub repo, add it as `origin` and push. */
  github: GithubRepoTarget.optional(),
  /** The user confirmed a first commit of a folder with very many files. */
  confirmManyFiles: z.boolean().optional(),
});
export type SetupProjectBody = z.infer<typeof SetupProjectBody>;

export interface ProjectSetupResult {
  /** The project folder (absolute). It exists whenever `createdFolder` is true, even if a later step failed. */
  projectPath: string;
  createdFolder: boolean;
  initializedGit: boolean;
  githubUrl: string | null;
  /** The step that failed; the steps before it stay done. */
  error: string | null;
  validation: ProjectValidation;
}

/** GET /api/github/account: who `gh` is signed in as, and where a repo can go. */
export interface GithubAccountView {
  ok: boolean;
  login: string | null;
  /** The login first, then its organizations. */
  owners: string[];
  /** Why repos can't be made (gh missing or signed out). */
  error: string | null;
}

/** Why `name` can't be a folder name (Windows rules everywhere, so the repo also checks out there), or null. */
export function folderNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Enter a folder name.';
  if (n === '.' || n === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(n)) return 'A folder name can\'t contain < > : " / \\ | ? *';
  if (/[. ]$/.test(n)) return "A folder name can't end with a dot or a space.";
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) return `"${n}" is a reserved name on Windows.`;
  return null;
}

/** A GitHub repo name made from a folder name: letters, digits, `.`, `-` and `_` only. */
export function githubRepoName(name: string): string {
  return name
    .trim()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 100);
}

export const GITHUB_REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
