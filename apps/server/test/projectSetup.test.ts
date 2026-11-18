import fs from 'node:fs';
import path from 'node:path';
import { folderNameProblem, githubRepoName } from '@t3-orchestra/shared';
import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBoard } from '../src/engine/boards.ts';
import { createApp } from '../src/http/app.ts';
import { countFiles, MANY_FILES, protectedFolder } from '../src/project-setup/folders.ts';
import { checkNewFolder, setupProject } from '../src/project-setup/setup.ts';
import { setup, type Harness } from './harness.ts';

// gh is never run here: "creating" a repo just adds the origin remote it would have added.
vi.mock('../src/project-setup/github.ts', () => ({
  githubAccount: async () => ({ ok: true, login: 'me', owners: ['me', 'acme'], error: null }),
  createPrivateRepo: async (dir: string, owner: string, name: string) => {
    if (name === 'taken') throw new Error('GraphQL: Name already exists on this account (createRepository)');
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${owner}/${name}.git`]);
    return `https://github.com/${owner}/${name}`;
  },
}));

let h: Harness;
afterEach(() => h?.cleanup());

// The first commit uses the user's git identity; tests bring their own.
const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(IDENTITY)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const git = async (dir: string, ...args: string[]) => (await execa('git', ['-C', dir, ...args])).stdout.trim();

/** T3 knows only projects added to it, like the real one. */
function strictT3(harness: Harness) {
  Object.assign((harness.fake as unknown as { opts: object }).opts, { allProjectsKnown: false });
}

describe('project setup', () => {
  it('checks a new folder before anything is made', async () => {
    h = await setup();
    expect(checkNewFolder(h.tmp, 'fresh')).toEqual({ path: path.join(h.tmp, 'fresh'), error: null });
    expect(checkNewFolder(h.tmp, 'repo').error).toMatch(/already exists/);
    expect(checkNewFolder(path.join(h.tmp, 'nope'), 'x').error).toMatch(/doesn't exist/);
    expect(checkNewFolder(h.tmp, 'a/b').error).toMatch(/can't contain/);
    expect(folderNameProblem('con')).toMatch(/reserved/);
    expect(folderNameProblem('trailing.')).toMatch(/end with/);
    expect(githubRepoName('Mein Projekt (v2)!')).toBe('Mein-Projekt-v2');
    expect(githubRepoName('Δοκιμή app')).toBe('app');
  });

  it('makes a new folder with git on the chosen branch, adds it to T3, and a board can use it', async () => {
    h = await setup();
    strictT3(h);
    const dir = path.join(h.tmp, 'brand new');
    const r = await setupProject(h.ctx, { projectPath: dir, createFolder: true, initBranch: 'trunk' });
    expect(r).toMatchObject({ projectPath: dir, createdFolder: true, initializedGit: true, githubUrl: null, error: null });
    expect(r.validation).toMatchObject({ ok: true, isGitRepo: true, baseBranch: 'trunk', baseBranchExists: true, t3Known: true, originUrl: null });
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# brand new\n');
    expect((await git(dir, 'ls-files')).split('\n').sort()).toEqual(['.gitignore', 'README.md']);
    expect(await git(dir, 'rev-list', '--count', 'trunk')).toBe('1');

    const board = await createBoard(h.ctx, { name: 'Brand new', projectPath: r.projectPath, baseBranch: 'trunk' });
    expect(board).toMatchObject({ projectPath: dir, baseBranch: 'trunk' });
  });

  it("commits an existing folder's files, leaving out what the default .gitignore covers", async () => {
    h = await setup();
    const dir = path.join(h.tmp, 'existing');
    fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), '');
    fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1)\n');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
    const r = await setupProject(h.ctx, { projectPath: dir, initBranch: 'main' });
    expect(r).toMatchObject({ createdFolder: false, initializedGit: true, error: null });
    expect((await git(dir, 'ls-files')).split('\n').sort()).toEqual(['.gitignore', 'index.js']);

    // A .gitignore of the user's own is kept as it is.
    const own = path.join(h.tmp, 'own-ignore');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, '.gitignore'), 'secret.txt\n');
    fs.writeFileSync(path.join(own, 'secret.txt'), 'x');
    await setupProject(h.ctx, { projectPath: own, initBranch: 'main' });
    expect(fs.readFileSync(path.join(own, '.gitignore'), 'utf8')).toBe('secret.txt\n');
    expect(await git(own, 'ls-files')).toBe('.gitignore');
  });

  it("won't start a repository in a personal folder, and wants a yes for very many files", async () => {
    h = await setup();
    const home = path.join(h.tmp, 'home');
    expect(protectedFolder(home, home)).toMatch(/home folder/);
    expect(protectedFolder(path.join(home, 'Documents'), home)).toMatch(/Documents folder/);
    expect(protectedFolder(path.join(home, 'OneDrive', 'Desktop'), home)).toMatch(/Desktop folder/);
    expect(protectedFolder(path.parse(h.tmp).root, home)).toMatch(/drive root/);
    expect(protectedFolder(path.join(home, 'Documents', 'my-app'), home)).toBeNull();

    const big = path.join(h.tmp, 'big');
    fs.mkdirSync(path.join(big, 'node_modules'), { recursive: true });
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(big, 'node_modules', `dep${i}.js`), '');
    fs.writeFileSync(path.join(big, 'a.txt'), '');
    expect(countFiles(big)).toEqual({ count: 1, more: false });
    for (let i = 0; i <= MANY_FILES; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), '');
    expect(countFiles(big)).toEqual({ count: MANY_FILES, more: true });

    const res = await createApp({ engine: h.engine, port: 4417 }).request('/api/validate-project', {
      method: 'POST',
      headers: { host: '127.0.0.1:4417', 'content-type': 'application/json', 'x-t3orchestra': '1' },
      body: JSON.stringify({ projectPath: big }),
    });
    expect(await res.json()).toMatchObject({ exists: true, isGitRepo: false, setupBlocked: null, folderFiles: { count: MANY_FILES, more: true } });
    await expect(setupProject(h.ctx, { projectPath: big, initBranch: 'main' })).rejects.toThrow(/more than 2,000 files/);
    expect(fs.existsSync(path.join(big, '.git'))).toBe(false);
  });

  it('changes nothing when the request cannot work', async () => {
    h = await setup();
    const dir = path.join(h.tmp, 'plain');
    fs.mkdirSync(dir);
    await expect(setupProject(h.ctx, { projectPath: dir })).rejects.toThrow(/not a git repository yet/);
    await expect(setupProject(h.ctx, { projectPath: dir, initBranch: 'a..b' })).rejects.toThrow(/can't be a branch name/);
    await expect(setupProject(h.ctx, { projectPath: dir, initBranch: 'main', github: { owner: 'me', name: 'bad name' } })).rejects.toThrow(/letters, digits/);
    await expect(setupProject(h.ctx, { projectPath: h.repo, createFolder: true, initBranch: 'main' })).rejects.toThrow(/already exists/);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
  });

  it('creates the GitHub repo as origin, and keeps the earlier steps when GitHub fails', async () => {
    h = await setup();
    const ok = await setupProject(h.ctx, { projectPath: path.join(h.tmp, 'pushed'), createFolder: true, initBranch: 'main', github: { owner: 'acme', name: 'pushed' } });
    expect(ok).toMatchObject({ githubUrl: 'https://github.com/acme/pushed', error: null });
    expect(ok.validation.originUrl).toBe('https://github.com/acme/pushed.git');

    const failed = await setupProject(h.ctx, { projectPath: path.join(h.tmp, 'taken'), createFolder: true, initBranch: 'main', github: { owner: 'me', name: 'taken' } });
    expect(failed).toMatchObject({ createdFolder: true, initializedGit: true, githubUrl: null });
    expect(failed.error).toMatch(/^Couldn't create the GitHub repo: .*already exists/);
    expect(failed.validation).toMatchObject({ ok: true, isGitRepo: true, originUrl: null });

    // An existing repository without a remote can get one too; with one it can't.
    const later = await setupProject(h.ctx, { projectPath: h.repo, github: { owner: 'me', name: 'repo' } });
    expect(later).toMatchObject({ initializedGit: false, githubUrl: 'https://github.com/me/repo', error: null });
    await expect(setupProject(h.ctx, { projectPath: h.repo, github: { owner: 'me', name: 'again' } })).rejects.toThrow(/already has an "origin"/);
  });

  it('serves the folder check, GitHub account and setup over HTTP', async () => {
    h = await setup();
    const app = createApp({ engine: h.engine, port: 4417 });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, {
        method,
        headers: { host: '127.0.0.1:4417', 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'x-t3orchestra': '1' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };
    expect((await call('POST', '/api/folders/check-new', { parent: h.tmp, name: 'web' })).json).toEqual({ path: path.join(h.tmp, 'web'), error: null });
    expect((await call('GET', '/api/github/account')).json).toMatchObject({ ok: true, owners: ['me', 'acme'] });
    const res = await call('POST', '/api/projects/setup', { projectPath: path.join(h.tmp, 'web'), createFolder: true, initBranch: 'main' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ createdFolder: true, initializedGit: true, validation: { ok: true, exists: true } });
    const again = await call('POST', '/api/projects/setup', { projectPath: path.join(h.tmp, 'web'), createFolder: true, initBranch: 'main' });
    expect(again.status).toBe(400);
    expect(again.json.error.code).toBe('VALIDATION');
  });
});
