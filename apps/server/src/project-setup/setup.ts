// New board → project setup: make the folder, `git init` with a first commit, a private GitHub repo, then
// tell T3 Code about the project. Each step runs only when asked for; a failed step keeps the ones before it.
import fs from 'node:fs';
import path from 'node:path';
import { folderNameProblem, GITHUB_REPO_NAME_RE, type NewFolderCheck, type ProjectSetupResult, type SetupProjectBody } from '@t3-orchestra/shared';
import { addProjectToT3, validateProject } from '../engine/boards.ts';
import { AppError, type EngineContext } from '../engine/context.ts';
import * as git from '../git/git.ts';
import { errorMessage } from '../util.ts';
import { countFiles, MANY_FILES, protectedFolder } from './folders.ts';
import { createPrivateRepo } from './github.ts';

/** Written only when the folder has none, so the first commit doesn't sweep up dependencies or secrets. */
export const DEFAULT_GITIGNORE = `# Added by T3 Orchestra when it set up git here.
node_modules/
.env
.env.*
!.env.example
dist/
.next/
coverage/
__pycache__/
*.py[cod]
.venv/
venv/
*.log
.DS_Store
Thumbs.db
`;

const clean = (p: string) => path.resolve(p.trim().replace(/^"|"$/g, ''));
const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();

export function checkNewFolder(parent: string, name: string): NewFolderCheck {
  const problem = folderNameProblem(name);
  if (problem) return { path: null, error: problem };
  const dir = clean(parent);
  if (!isDir(dir)) return { path: null, error: `The location doesn't exist: ${dir}` };
  const target = path.join(dir, name.trim());
  if (fs.existsSync(target)) {
    return { path: target, error: `"${name.trim()}" already exists there. Pick it under "Existing folder" instead, or choose another name.` };
  }
  return { path: target, error: null };
}

function stepError(step: 'folder' | 'git' | 'github', err: unknown): string {
  const msg = errorMessage(err);
  if (step === 'git' && /tell me who you are|empty ident name|user\.(email|name)/i.test(msg)) {
    return 'Git doesn\'t know your name and email yet. Run git config --global user.name "Your Name" and git config --global user.email "you@example.com", then try again.';
  }
  return { folder: "Couldn't create the folder: ", git: '', github: "Couldn't create the GitHub repo: " }[step] + msg;
}

export async function setupProject(ctx: EngineContext, body: SetupProjectBody): Promise<ProjectSetupResult> {
  // Everything that can be checked up front is, so a request that can't work changes nothing.
  const requested = clean(body.projectPath);
  let dir = requested;
  if (body.createFolder) {
    const check = checkNewFolder(path.dirname(requested), path.basename(requested));
    if (check.error || !check.path) throw new AppError('VALIDATION', check.error ?? 'Choose a folder name.');
    dir = check.path;
  } else if (!isDir(dir)) {
    throw new AppError('VALIDATION', `Not a folder: ${dir}`);
  }
  const top = body.createFolder ? null : await git.toplevel(dir);
  const initBranch = top ? null : body.initBranch;
  if (!top && !initBranch) throw new AppError('VALIDATION', `${dir} is not a git repository yet; choose the branch to start it on.`);
  if (initBranch && !(await git.validBranchName(initBranch))) throw new AppError('VALIDATION', `"${initBranch}" can't be a branch name.`);
  if (initBranch && !body.createFolder) {
    const blocked = protectedFolder(dir);
    if (blocked) throw new AppError('VALIDATION', blocked);
    if (countFiles(dir).more && !body.confirmManyFiles) {
      throw new AppError('VALIDATION', `${dir} has more than ${MANY_FILES.toLocaleString('en')} files; confirm that all of them belong in the first commit.`);
    }
  }
  if (body.github) {
    if (!GITHUB_REPO_NAME_RE.test(body.github.name)) {
      throw new AppError('VALIDATION', 'A GitHub repo name may only contain letters, digits, ".", "-" and "_".');
    }
    if (top && (await git.remoteUrl(top, 'origin'))) throw new AppError('VALIDATION', 'The repository already has an "origin" remote.');
  }

  const projectPath = top ? path.resolve(top) : dir;
  const result: Omit<ProjectSetupResult, 'validation'> = { projectPath, createdFolder: false, initializedGit: false, githubUrl: null, error: null };
  let step: 'folder' | 'git' | 'github' = 'folder';
  try {
    if (body.createFolder) {
      fs.mkdirSync(dir);
      result.createdFolder = true;
      fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
    }
    if (initBranch) {
      step = 'git';
      const ignore = path.join(dir, '.gitignore');
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, DEFAULT_GITIGNORE);
      await git.initWithFirstCommit(dir, initBranch, 'Initial commit');
      result.initializedGit = true;
    }
    if (body.github) {
      step = 'github';
      result.githubUrl = await createPrivateRepo(projectPath, body.github.owner, body.github.name);
    }
  } catch (err) {
    result.error = stepError(step, err);
  }
  // T3 Code has to know the project before a board can use it, and never knows a repository made just now.
  const branch = initBranch ?? undefined;
  const validation = top || result.initializedGit ? await addProjectToT3(ctx, projectPath, branch) : await validateProject(ctx, projectPath, branch);
  return { ...result, validation };
}
