import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectRunView, RunRecipe, StreamEvents } from '@t3-orchestra/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.ts';
import { createApp } from '../src/http/app.ts';
import { composeDown, detectRecipes, q, type DetectEnv } from '../src/project-run/detect.ts';
import { ProjectRunManager } from '../src/project-run/manager.ts';
import { childEnv, extractUrl, freePort, isAlive, vsCodeExe } from '../src/project-run/system.ts';
import { runAction } from '../src/engine/actions.ts';
import { errorLine } from '../src/project-run/fix.ts';
import { implDone, reviewPass, setup, type Harness } from './harness.ts';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't3orchestra-run-'));
  temps.push(d);
  return d;
}

/** Writes `files` (path → content; objects become JSON) under a new temp dir. */
function project(files: Record<string, string | object>): string {
  const dir = tmpdir();
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

function env(o: { tools?: string[]; platform?: NodeJS.Platform } = {}): DetectEnv {
  const tools = new Set(o.tools ?? ['node', 'npm', 'pnpm', 'py', 'gcc', 'cargo', 'go', 'dotnet', 'cmake', 'php']);
  return { platform: o.platform ?? 'win32', has: async (c) => tools.has(c), port: async (p) => p, buildDir: 'C:\\data\\run-builds\\abc' };
}

const commands = (r: RunRecipe) => r.steps.map((s) => s.command);

describe('detectRecipes', () => {
  it('finds a Vite app, its package manager, and the missing install', async () => {
    const dir = project({ 'package.json': { scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^8' } }, 'pnpm-lock.yaml': '' });
    const [best] = await detectRecipes(dir, env());
    expect(best).toMatchObject({ label: 'Vite dev server', kind: 'web', mode: 'background', cwd: '' });
    expect(commands(best!)).toEqual(['pnpm install', 'pnpm run dev']);
  });

  it('skips the install when node_modules exists, and ranks a desktop app first', async () => {
    const dir = project({
      'package.json': { scripts: { dev: 'electron-vite dev', start: 'electron .' }, devDependencies: { electron: '^40', vite: '^8' } },
      'package-lock.json': '{}',
      'node_modules/.keep': '',
    });
    const [best, next] = await detectRecipes(dir, env());
    expect(best).toMatchObject({ label: 'Electron app', kind: 'app' });
    expect(commands(best!)).toEqual(['npm run dev']);
    expect(next!.label).toBe('Vite dev server');
  });

  it('installs again over what a failed pnpm install left behind', async () => {
    const files = { 'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '^8' } }, 'pnpm-lock.yaml': '', 'node_modules/.pnpm/.keep': '' };
    expect(commands((await detectRecipes(project(files), env()))[0]!)).toEqual(['pnpm install', 'pnpm run dev']);
    const done = project({ ...files, 'node_modules/.modules.yaml': '' });
    expect(commands((await detectRecipes(done, env()))[0]!)).toEqual(['pnpm run dev']);
  });

  it('does not run a library entry file', async () => {
    const dir = project({ 'package.json': { main: 'index.js', peerDependencies: { react: '*' } }, 'index.js': '' });
    expect(await detectRecipes(dir, env())).toEqual([]);
  });

  it('runs Django with a chosen port and URL', async () => {
    const dir = project({ 'manage.py': '', 'requirements.txt': 'django' });
    const [best] = await detectRecipes(dir, env());
    expect(best).toMatchObject({ label: 'Django dev server', url: 'http://127.0.0.1:8000/' });
    expect(commands(best!)).toEqual(['py manage.py runserver 127.0.0.1:8000']);
  });

  it('loads a Flask app object, and a FastAPI factory with --factory', async () => {
    const flask = project({ 'app.py': 'from flask import Flask\napp = Flask(__name__)\n' });
    expect(commands((await detectRecipes(flask, env()))[0]!)).toEqual(['py -m flask --app app:app run --port 5000']);

    const fastapi = project({ 'main.py': 'from fastapi import FastAPI\n\ndef create_app() -> FastAPI:\n    app = FastAPI()\n    return app\n' });
    expect(commands((await detectRecipes(fastapi, env()))[0]!)).toEqual(['py -m uvicorn --factory main:create_app --port 8000']);
  });

  it('starts a frontend and its API side by side when they live in separate folders', async () => {
    const dir = project({
      'frontend/package.json': { scripts: { dev: 'next dev' }, dependencies: { next: '^16' } },
      'frontend/node_modules/.keep': '',
      'backend/pyproject.toml': '[project]\nname = "api"\n',
      'backend/app/__init__.py': '',
      'backend/app/main.py': 'from fastapi import FastAPI\n\ndef create_app() -> FastAPI:\n    return FastAPI()\n',
    });
    const [best] = await detectRecipes(dir, env());
    expect(best!.label).toBe('Next.js dev server + FastAPI app');
    expect(best!.parts!.map((p) => [p.cwd, p.steps.map((s) => s.command)])).toEqual([
      ['frontend', ['npm run dev']],
      ['backend', ['py -m uvicorn --factory app.main:create_app --port 8000']],
    ]);
  });

  it('compiles loose C sources outside the repo and runs them in a console window', async () => {
    const dir = project({ 'main.c': 'int main(void) { return 0; }\n', 'util.c': 'int add(int a, int b) { return a + b; }\n' });
    const [best] = await detectRecipes(dir, env());
    expect(best).toMatchObject({ kind: 'console', mode: 'terminal', warning: null });
    const out = path.join('C:\\data\\run-builds\\abc', 'c', '.', `${path.basename(dir)}.exe`);
    expect(commands(best!)[0]).toBe(`gcc main.c util.c -o ${q(out)}`);
    expect(best!.steps[1]!.candidates).toEqual([out]);
  });

  it('warns when no compiler is installed', async () => {
    const dir = project({ 'main.cpp': 'int main() {}\n' });
    const [best] = await detectRecipes(dir, env({ tools: [] }));
    expect(best!.warning).toMatch(/No C\+\+ compiler/);
  });

  it('builds CMake projects into the build dir and runs the executable', async () => {
    const dir = project({ 'CMakeLists.txt': 'project(demo)\nadd_executable(${PROJECT_NAME} main.cpp)\n', 'main.cpp': 'int main() {}' });
    const [best] = await detectRecipes(dir, env());
    expect(best!.label).toBe('demo (CMake)');
    expect(best!.steps.map((s) => s.label)).toEqual(['Configure', 'Build', 'Run']);
    expect(best!.steps[2]!.candidates!.every((c) => c.endsWith('demo.exe'))).toBe(true);
  });

  it('tells web servers from console programs in Rust, Go and .NET', async () => {
    const axum = project({ 'Cargo.toml': '[package]\nname = "x"\n[dependencies]\naxum = "0.8"\n' });
    expect((await detectRecipes(axum, env()))[0]).toMatchObject({ kind: 'web', mode: 'background' });
    const cli = project({ 'Cargo.toml': '[package]\nname = "x"\n' });
    expect((await detectRecipes(cli, env()))[0]).toMatchObject({ kind: 'console', mode: 'terminal' });

    const goWeb = project({ 'go.mod': 'module x', 'main.go': 'package main\nimport "net/http"\nfunc main() {}\n' });
    expect((await detectRecipes(goWeb, env()))[0]).toMatchObject({ kind: 'web', label: 'go run .' });

    const web = project({ 'Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' });
    expect((await detectRecipes(web, env()))[0]).toMatchObject({ kind: 'web', label: 'ASP.NET app (Api.csproj)' });
  });

  it('serves a plain HTML site with the built-in server', async () => {
    const dir = project({ 'index.html': '<h1>hi</h1>' });
    const [best] = await detectRecipes(dir, env());
    expect(best).toMatchObject({ label: 'Static site', url: 'http://127.0.0.1:8080/' });
    expect(best!.steps[0]!.staticDir).toBe('.');
  });

  it('offers Jupyter for notebooks and nothing for Android apps', async () => {
    const nb = project({ 'analysis.ipynb': '{}' });
    expect((await detectRecipes(nb, env({ tools: ['jupyter-lab'] })))[0]).toMatchObject({ label: 'Jupyter', steps: [{ command: 'jupyter lab --no-browser' }] });

    const android = project({ 'settings.gradle': 'include ":app"', 'build.gradle': 'plugins { id "application" }', 'app/build.gradle': 'apply plugin: "com.android.application"' });
    expect(await detectRecipes(android, env())).toEqual([]);
  });

  it('looks inside apps/* when the root has nothing to run', async () => {
    const dir = project({ 'package.json': { private: true, workspaces: ['apps/*'] }, 'apps/web/package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '*' } } });
    const [best] = await detectRecipes(dir, env());
    expect(best).toMatchObject({ label: 'Vite dev server', cwd: 'apps/web' });
  });

  it('returns nothing for a folder with only docs', async () => {
    expect(await detectRecipes(project({ 'README.md': '# x', 'docs/SPEC.md': '' }), env())).toEqual([]);
  });

  it("knows how to stop what a project starts in the background: its stop script, or the compose file's down", async () => {
    const launcher = project({
      'package.json': { scripts: { dev: 'node scripts/dev.mjs', stop: 'docker compose down && supabase stop' }, packageManager: 'pnpm@10.0.0' },
      'node_modules/.keep': '',
    });
    expect((await detectRecipes(launcher, env()))[0]).toMatchObject({ label: 'pnpm run dev', stop: 'pnpm run stop' });

    const inline = project({ 'package.json': { scripts: { dev: 'docker compose --file infra/compose.yml --env-file .env up --build -d' } }, 'node_modules/.keep': '' });
    expect((await detectRecipes(inline, env()))[0]!.stop).toBe('docker compose --file infra/compose.yml --env-file .env down');

    const compose = project({ 'docker-compose.yml': 'services:\n  web:\n    ports:\n      - "8080:80"\n' });
    expect((await detectRecipes(compose, env({ tools: ['docker'] })))[0]).toMatchObject({ url: 'http://localhost:8080/', stop: 'docker compose down' });

    const vite = project({ 'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '*' } }, 'node_modules/.keep': '' });
    expect((await detectRecipes(vite, env()))[0]!.stop).toBeUndefined();

    expect(composeDown('docker-compose up -d && next dev')).toBe('docker-compose down');
    expect(composeDown('docker compose -p shop --profile dev up')).toBe('docker compose -p shop --profile dev down');
    expect(composeDown('docker compose logs up')).toBeUndefined();
    expect(composeDown('echo up')).toBeUndefined();
  });
});

describe('extractUrl', () => {
  it('reads the local URL dev servers print', () => {
    expect(extractUrl('  \u279c  Local:   http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(extractUrl('Starting development server at http://127.0.0.1:8000/')).toBe('http://127.0.0.1:8000/');
    expect(extractUrl('Serving HTTP on :: port 8000 (http://[::]:8000/) ...')).toBe('http://localhost:8000/');
    expect(extractUrl('INFO: Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)')).toBe('http://localhost:8000');
    expect(extractUrl('Tomcat started on port 8080 (http) with context path')).toBe('http://localhost:8080/');
    expect(extractUrl('Server listening on port 3000')).toBe('http://localhost:3000/');
  });

  it('ignores debugger sockets, remote URLs and clock times', () => {
    expect(extractUrl('Debugger listening on ws://127.0.0.1:9229/abc')).toBeNull();
    expect(extractUrl('see https://vite.dev/config for details')).toBeNull();
    expect(extractUrl('Build started at 12:30')).toBeNull();
  });
});

describe('childEnv', () => {
  it("drops node --watch's dependency reporting, which breaks pnpm install", () => {
    const e = childEnv({ WATCH_REPORT_DEPENDENCIES: '1', npm_lifecycle_event: 'dev', PNPM_HOME: 'C:\\pnpm', PATH: '' });
    expect(e.WATCH_REPORT_DEPENDENCIES).toBeUndefined();
    expect(e.npm_lifecycle_event).toBeUndefined();
    expect(e.PNPM_HOME).toBe('C:\\pnpm');
  });
});

describe('vsCodeExe', () => {
  it.skipIf(process.platform !== 'win32')('finds Code.exe next to the code command on PATH, else in a standard install', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-'));
    const touch = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), '');
    };
    try {
      touch('VS Code/bin/code.cmd');
      touch('VS Code/Code.exe');
      touch('local/Programs/Microsoft VS Code/Code.exe');
      const onPathDir = `"${path.join(root, 'VS Code', 'bin')}"`;
      expect(vsCodeExe({ PATH: `${root};${onPathDir}`, LOCALAPPDATA: path.join(root, 'local') })).toBe(path.win32.join(root, 'VS Code', 'Code.exe'));
      expect(vsCodeExe({ PATH: root, LOCALAPPDATA: path.join(root, 'local') })).toBe(path.win32.join(root, 'local', 'Programs', 'Microsoft VS Code', 'Code.exe'));
      expect(vsCodeExe({ PATH: root })).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('errorLine', () => {
  it("picks the failed part's error, not T3 Orchestra's own lines or stack frames", () => {
    const part = (label: string) => ({ label, cwd: label, steps: [], url: null, kind: 'web' as const });
    const run = {
      recipe: recipe([], { parts: [part('Next.js dev server'), part('FastAPI app')] }),
      error: 'Next.js dev server: Install dependencies failed (exit code 1).',
    } as ProjectRunView;
    const log = [
      '[Next.js dev server] $ pnpm install',
      '[FastAPI app] $ uv run python -m uvicorn --factory app.main:create_app --port 8000',
      "[Next.js dev server] ERROR Cannot destructure property 'verified' of '(intermediate value)' as it is undefined.",
      "[Next.js dev server] pnpm: Cannot destructure property 'verified' of '(intermediate value)' as it is undefined.",
      '[Next.js dev server]     at doFetchToStore (pnpm.cjs:117052:21)',
      '[FastAPI app] ERROR: connection refused',
      '',
      'Next.js dev server: Install dependencies failed (exit code 1).',
    ].join('\n');
    expect(errorLine(run, log)).toBe("pnpm: Cannot destructure property 'verified' of '(intermediate value)' as it is undefined.");
    expect(errorLine({ ...run, recipe: recipe(['x']), error: 'Exited with code 1.' } as ProjectRunView, 'all good\nExited with code 1.')).toBeNull();
  });
});

// ---- the manager, with real processes ------------------------------------------------------

const NODE = q(process.execPath);
const SERVER_JS = `
const http = require('http');
const s = http.createServer((req, res) => res.end('hello from ' + process.argv[2]));
s.listen(0, '127.0.0.1', () => console.log('  Network: http://192.168.1.5:1/\\n  Local:   http://' + (process.argv[3] || '127.0.0.1') + ':' + s.address().port + '/'));
`;

function harness(o: { backgroundPollMs?: number } = {}) {
  const dataDir = tmpdir();
  const bus = new Bus();
  const runs = new ProjectRunManager({ bus, dataDir, ...o });
  const events: Array<{ event: keyof StreamEvents; data: unknown }> = [];
  bus.subscribe((m) => events.push(m));
  const managers = [runs];
  const until = async (id: string, pred: (v: ProjectRunView) => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = runs.get(id)!;
      if (pred(v)) return v;
      if (Date.now() > end) throw new Error(`timed out; run is ${v.status}\n${runs.log(id)?.text}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { dataDir, bus, runs, events, managers, until };
}

function recipe(steps: string[], extra: Partial<RunRecipe> = {}): RunRecipe {
  return {
    id: 'test',
    label: 'Test',
    kind: 'web',
    mode: 'background',
    cwd: '',
    steps: steps.map((command, i) => ({ label: `Step ${i + 1}`, command })),
    reason: '',
    url: null,
    source: 'custom',
    warning: null,
    ...extra,
  };
}

describe('ProjectRunManager', () => {
  let h: ReturnType<typeof harness> | null = null;
  afterEach(() => {
    for (const m of h?.managers ?? []) m.stopAll();
    h = null;
  });

  it('runs setup steps, finds the Local URL, waits for it to answer, and stops the process tree', async () => {
    h = harness();
    const dir = project({ 'server.js': SERVER_JS });
    const started = await h.runs.start({ boardId: 'b', taskId: null, dir }, recipe([`${NODE} -e "console.log('setup ok')"`, `${NODE} server.js one localhost`]));
    const ready = await h.until(started.id, (v) => v.status === 'ready');
    expect(ready.url).toMatch(/^http:\/\/localhost:\d+\/$/); // Local wins over the Network line printed before it
    expect(await (await fetch(ready.url!)).text()).toBe('hello from one');
    expect(h.runs.log(started.id)!.text).toContain('setup ok');

    const pid = ready.pid!;
    const stopped = await h.runs.stop(started.id);
    expect(stopped).toMatchObject({ status: 'stopped', pid: null });
    expect(isAlive(pid)).toBe(false);
    await expect(fetch(ready.url!)).rejects.toThrow();
  });

  it('fails on a setup step that exits non-zero and never starts the program', async () => {
    h = harness();
    const dir = tmpdir();
    const { id } = await h.runs.start({ boardId: 'b', taskId: null, dir }, recipe([`${NODE} -e "process.exit(3)"`, `${NODE} -e "console.log('never')"`]));
    const v = await h.until(id, (x) => x.status === 'failed');
    expect(v).toMatchObject({ step: 0, exitCode: 3, error: 'Step 1 failed (exit code 3).' });
    expect(h.runs.log(id)!.text).not.toContain('never');
  });

  it('streams output with offsets that line up with the log', async () => {
    h = harness();
    const { id } = await h.runs.start({ boardId: 'b', taskId: null, dir: tmpdir() }, recipe([`${NODE} -e "for (let i = 0; i < 50; i++) console.log('line ' + i)"`]));
    await h.until(id, (x) => x.status === 'exited');
    await new Promise((r) => setTimeout(r, 200));
    const chunks = h.events.filter((e) => e.event === 'project_run_log').map((e) => e.data as StreamEvents['project_run_log']);
    let text = '';
    for (const c of chunks) {
      expect(c.start).toBe(text.length);
      text += c.text;
    }
    const log = h.runs.log(id)!;
    expect(text).toBe(log.text);
    expect(log.end).toBe(text.length);
    expect(text).toContain('line 49');
  });

  it('serves a static site until stopped', async () => {
    h = harness();
    const dir = project({ 'index.html': '<h1>static</h1>' });
    const port = await freePort(18080);
    const [r] = await detectRecipes(dir, { ...env({ platform: process.platform }), port: async () => port });
    const { id } = await h.runs.start({ boardId: 'b', taskId: null, dir }, r!);
    const v = await h.until(id, (x) => x.status === 'ready');
    expect(await (await fetch(v.url!)).text()).toBe('<h1>static</h1>');
    expect((await fetch(`${v.url}../../etc/passwd`)).status).toBe(404);
    await h.runs.stop(id);
    await expect(fetch(v.url!)).rejects.toThrow();
  });

  it('runs parts side by side, prefixes their output, and stops them all', async () => {
    h = harness();
    const dir = project({ 'web/server.js': SERVER_JS, 'api/server.js': SERVER_JS });
    const part = (label: string, cwd: string) => ({ label, cwd, steps: [{ label: 'Run', command: `${NODE} server.js ${label}` }], url: null, kind: 'web' as const });
    const { id } = await h.runs.start({ boardId: 'b', taskId: null, dir }, recipe([], { parts: [part('web', 'web'), part('api', 'api')] }));
    const v = await h.until(id, (x) => x.status === 'ready');
    expect(await (await fetch(v.url!)).text()).toBe('hello from web');
    await h.until(id, () => /\[api\]\s+Local:/.test(h!.runs.log(id)!.text));
    const apiUrl = /\[api\]\s+Local:\s+(\S+)/.exec(h.runs.log(id)!.text)![1]!;
    expect(await (await fetch(apiUrl)).text()).toBe('hello from api');

    await h.runs.stop(id);
    await expect(fetch(apiUrl)).rejects.toThrow();
  });

  it('a new run on the same target replaces the old one', async () => {
    h = harness();
    const dir = project({ 'server.js': SERVER_JS });
    const first = await h.runs.start({ boardId: 'b', taskId: 't', dir }, recipe([`${NODE} server.js a`]));
    const a = await h.until(first.id, (x) => x.status === 'ready');
    const second = await h.runs.start({ boardId: 'b', taskId: 't', dir }, recipe([`${NODE} server.js b`]));
    expect(h.runs.get(first.id)).toBeNull();
    await expect(fetch(a.url!)).rejects.toThrow();
    await h.until(second.id, (x) => x.status === 'ready');
    expect(h.runs.list()).toHaveLength(1);
    expect(h.runs.current('b', 't')!.id).toBe(second.id);
    expect(h.runs.current('b', null)).toBeNull();
  });

  it('kills programs a crashed server left behind, on the next start', async () => {
    h = harness();
    const dir = project({ 'server.js': SERVER_JS });
    const { id } = await h.runs.start({ boardId: 'b', taskId: null, dir }, recipe([`${NODE} server.js left`]));
    const v = await h.until(id, (x) => x.status === 'ready');
    // The old manager "crashes": it never stops its run. A new one with the same data dir cleans up.
    const next = new ProjectRunManager({ bus: new Bus(), dataDir: h.dataDir });
    h.managers.push(next);
    next.cleanupOrphans();
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(v.pid!)).toBe(false);
    await expect(fetch(v.url!)).rejects.toThrow();
  });

  it('also kills a server whose parents died with the old T3 Orchestra (like npm under a crashed server)', async () => {
    h = harness();
    const parentJs = `require('child_process').spawn(process.execPath, ['server.js', 'deep'], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
    const dir = project({ 'server.js': SERVER_JS, 'parent.js': parentJs });
    const { id } = await h.runs.start({ boardId: 'b', taskId: null, dir }, recipe([`${NODE} parent.js`]));
    const v = await h.until(id, (x) => x.status === 'ready');
    const file = path.join(h.dataDir, 'project-runs.json');
    let tree: Array<{ pid: number; startedAt: number }> = [];
    for (let i = 0; i < 100 && tree.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
      tree = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    }
    expect(tree.length).toBeGreaterThanOrEqual(3); // shell, parent.js, server.js

    // The crash: the shell and parent.js die, server.js lives on with no parent.
    const saved = fs.readFileSync(file, 'utf8');
    process.kill(tree[0]!.pid);
    process.kill(tree[1]!.pid);
    await new Promise((r) => setTimeout(r, 300));
    expect(await (await fetch(v.url!)).text()).toBe('hello from deep');

    const dataDir = tmpdir();
    fs.writeFileSync(path.join(dataDir, 'project-runs.json'), saved);
    const next = new ProjectRunManager({ bus: new Bus(), dataDir });
    h.managers.push(next);
    next.cleanupOrphans();
    await new Promise((r) => setTimeout(r, 300));
    await expect(fetch(v.url!)).rejects.toThrow();
  });

  // Like `pnpm dev` running `docker compose up --detach`: the command starts the app, prints its URL and exits.
  const LAUNCH_JS = `
const fs = require('fs');
require('child_process').spawn(process.execPath, ['server.js'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
const t = setInterval(() => {
  if (!fs.existsSync('port')) return;
  clearInterval(t);
  console.log('App running at http://127.0.0.1:' + fs.readFileSync('port', 'utf8') + '/');
}, 50);
`;
  const DETACHED_SERVER_JS = `
const fs = require('fs');
const s = require('http').createServer((req, res) => res.end('hello from the background'));
s.listen(0, '127.0.0.1', () => { fs.writeFileSync('pid', String(process.pid)); fs.writeFileSync('port', String(s.address().port)); });
`;
  const STOP_JS = `
const fs = require('fs');
fs.writeFileSync('stopped', '1');
try { process.kill(Number(fs.readFileSync('pid', 'utf8'))); } catch {}
`;
  const gone = async (url: string) => {
    for (let i = 0; i < 40; i++) {
      if (!(await fetch(url).then(() => true, () => false))) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  const backgroundProject = () => {
    const dir = project({ 'launch.js': LAUNCH_JS, 'server.js': DETACHED_SERVER_JS, 'stop.js': STOP_JS });
    // Also for a test that fails half way: the detached server must not outlive it.
    const kill = () => {
      try {
        process.kill(Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8')));
      } catch {
        // not started, or already stopped
      }
    };
    return { dir, kill };
  };

  it("keeps a run whose command left the app running, and Stop runs the project's stop command", async () => {
    h = harness({ backgroundPollMs: 100 });
    const { dir, kill } = backgroundProject();
    try {
      const { id } = await h.runs.start({ boardId: 'b', taskId: null, dir }, recipe([`${NODE} launch.js`], { stop: `${NODE} stop.js` }));
      const v = await h.until(id, (x) => x.background);
      expect(v).toMatchObject({ status: 'ready', pid: null, exitCode: 0, stopping: false });
      expect(await (await fetch(v.url!)).text()).toBe('hello from the background');
      expect(h.runs.log(id)!.text).toContain('keeps running in the background');
      expect(fs.existsSync(path.join(h.dataDir, 'background-runs.json'))).toBe(true);

      const stopping = h.runs.stop(id);
      expect(h.runs.get(id)!.stopping).toBe(true);
      expect(await stopping).toMatchObject({ status: 'stopped', background: false, stopping: false, error: null });
      expect(fs.existsSync(path.join(dir, 'stopped'))).toBe(true);
      expect(await gone(v.url!)).toBe(true);
      expect(h.runs.log(id)!.text).toContain(`$ ${NODE} stop.js`);
      expect(fs.existsSync(path.join(h.dataDir, 'background-runs.json'))).toBe(false);
    } finally {
      kill();
    }
  });

  it('shows a background app again after a restart, and notices when it is stopped elsewhere', async () => {
    h = harness({ backgroundPollMs: 100 });
    const { dir, kill } = backgroundProject();
    try {
      const { id } = await h.runs.start({ boardId: 'b', taskId: null, dir }, recipe([`${NODE} launch.js`], { stop: `${NODE} stop.js` }));
      const v = await h.until(id, (x) => x.background);

      h.runs.stopAll(); // T3 Orchestra shuts down: the app it didn't start itself keeps running
      expect(await (await fetch(v.url!)).text()).toBe('hello from the background');
      const next = new ProjectRunManager({ bus: new Bus(), dataDir: h.dataDir, backgroundPollMs: 100 });
      h.managers.push(next);
      next.restoreBackground();
      expect(next.current('b', null)).toMatchObject({ id, status: 'ready', background: true, url: v.url });
      expect(next.log(id)!.text).toContain('T3 Orchestra restarted');

      kill(); // e.g. `docker compose down` in a terminal
      for (let i = 0; i < 60 && next.get(id)!.status !== 'exited'; i++) await new Promise((r) => setTimeout(r, 50));
      expect(next.get(id)).toMatchObject({ status: 'exited', background: false });
      expect(next.log(id)!.text).toContain('no longer answers');
      expect(fs.existsSync(path.join(h.dataDir, 'background-runs.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'stopped'))).toBe(false);
    } finally {
      kill();
    }
  });

  it('runs the stop command when a running program is stopped, but not before the program started', async () => {
    h = harness();
    const dir = project({ 'server.js': SERVER_JS });
    const mark = `${NODE} -e "require('fs').writeFileSync('stopped', '1')"`;
    const a = await h.runs.start({ boardId: 'b', taskId: null, dir }, recipe([`${NODE} -e "setTimeout(() => {}, 20000)"`, `${NODE} server.js x`], { stop: mark }));
    await h.until(a.id, (x) => x.pid !== null);
    await h.runs.stop(a.id);
    expect(fs.existsSync(path.join(dir, 'stopped'))).toBe(false);

    const b = await h.runs.start({ boardId: 'b', taskId: null, dir }, recipe([`${NODE} server.js x`], { stop: mark }));
    await h.until(b.id, (x) => x.status === 'ready');
    await h.runs.stop(b.id);
    expect(fs.existsSync(path.join(dir, 'stopped'))).toBe(true);
  });
});

describe('Run project API', () => {
  let hh: Harness | null = null;
  afterEach(() => {
    hh?.cleanup();
    hh = null;
  });

  const PORT = 4417;
  async function call(method: string, url: string, body?: unknown) {
    const app = createApp({ engine: hh!.engine, port: PORT });
    const res = await app.request(url, {
      method,
      headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'x-t3orchestra': '1' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  }

  it('says when it cannot tell how to run the project, then runs and saves your own command', async () => {
    hh = await setup();
    const info = await call('GET', `/api/boards/${hh.board.id}/run`);
    expect(info.json).toMatchObject({ dir: hh.repo, recipes: [], config: null, run: null });

    const none = await call('POST', `/api/boards/${hh.board.id}/run`, {});
    expect(none).toMatchObject({ status: 422, json: { error: { code: 'NOTHING_TO_RUN' } } });

    const config = { command: `${NODE} -e "console.log('custom ran')"`, mode: 'background', cwd: '' };
    const run = await call('POST', `/api/boards/${hh.board.id}/run`, { config, save: true });
    expect(run.json).toMatchObject({ boardId: hh.board.id, taskId: null, recipe: { id: 'custom', source: 'custom' } });
    const runs = hh.engine.projectRuns;
    for (let i = 0; i < 200 && runs.get(run.json.id)!.status !== 'exited'; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await call('GET', `/api/project-runs/${run.json.id}/log`)).json.text).toContain('custom ran');

    const after = await call('GET', `/api/boards/${hh.board.id}/run`);
    expect(after.json.config).toEqual(config);
    expect(after.json.recipes[0]).toMatchObject({ id: 'custom', steps: [{ command: config.command }] });
    expect((await call('GET', `/api/boards/${hh.board.id}`)).json.runConfig).toEqual(config);
    expect((await call('GET', '/api/project-runs')).json).toHaveLength(1);
  });

  it('keeps commands inside the project and needs a worktree for task runs', async () => {
    hh = await setup();
    const escape = await call('POST', `/api/boards/${hh.board.id}/run`, { config: { command: 'echo hi', cwd: '..' } });
    expect(escape).toMatchObject({ status: 400, json: { error: { message: 'The folder must be inside the project.' } } });

    const task = hh.newTask({ title: 'x' });
    const r = await call('GET', `/api/tasks/${task.id}/run`);
    expect(r).toMatchObject({ status: 400, json: { error: { code: 'VALIDATION' } } });
    expect(await call('POST', `/api/tasks/${task.id}/open-in-vscode`)).toMatchObject({ status: 400, json: { error: { code: 'VALIDATION' } } });
    expect((await call('POST', '/api/project-runs/nope/stop')).status).toBe(404);
  });

  it("links the GitHub page of the project's origin remote", async () => {
    hh = await setup();
    const github = async () => (await call('GET', `/api/boards/${hh!.board.id}/github`)).json;
    expect(await github()).toEqual({ url: null });
    execFileSync('git', ['-C', hh.repo, 'remote', 'add', 'origin', 'git@github.com:acme/rocket.js.git']);
    expect(await github()).toEqual({ url: 'https://github.com/acme/rocket.js' });
    execFileSync('git', ['-C', hh.repo, 'remote', 'set-url', 'origin', 'https://x-access-token:secret@github.com/acme/rocket.git']);
    expect(await github()).toEqual({ url: 'https://github.com/acme/rocket' });
    execFileSync('git', ['-C', hh.repo, 'remote', 'set-url', 'origin', 'https://gitlab.com/acme/rocket.git']);
    expect(await github()).toEqual({ url: null });
  });

  async function failedRun(taskId: string | null) {
    const runs = hh!.engine.projectRuns;
    const cmd = `${NODE} -e "console.log('Error: config.json <store> is missing'); console.log('    at main (x.js:1:1)'); process.exit(2)"`;
    const run = await runs.start({ boardId: hh!.board.id, taskId, dir: hh!.repo }, recipe([`${NODE} -e "console.log('installed')"`, cmd], { label: 'Vite dev server' }));
    for (let i = 0; i < 200 && runs.get(run.id)!.status !== 'failed'; i++) await new Promise((r) => setTimeout(r, 50));
    return runs.get(run.id)!;
  }

  it('Fix with AI turns a failed board run into a started task that carries the error and output', async () => {
    hh = await setup();
    const run = await failedRun(null);
    expect(run.error).toBe('Exited with code 2.');

    const r = await call('POST', `/api/project-runs/${run.id}/fix`, { note: 'it worked yesterday' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ created: true, startError: null, task: { title: 'Fix "Run project": Error: config.json <store> is missing', category: 'bug', stage: 'implementing' } });
    expect(r.json.run.fixTaskId).toBe(r.json.task.id);
    expect(hh.engine.projectRuns.get(run.id)!.fixTaskId).toBe(r.json.task.id);

    const start = hh.fake.calls.find((c) => c.op === 'start')!.args as { message: string };
    expect(start.message).toContain('"Run project" (Vite dev server) failed in the project root');
    expect(start.message).toContain('What went wrong: Exited with code 2. Error: config.json <store> is missing'); // not HTML-escaped
    expect(start.message).toContain('    at main (x.js:1:1)');
    expect(start.message).toContain('From the user: it worked yesterday');
    expect(start.message).toMatch(/- in `\.`: `.*console\.log\('installed'\).*` → `/);

    const again = await call('POST', `/api/project-runs/${(await call('POST', `/api/boards/${hh.board.id}/run`, { config: { command: 'echo ok' } })).json.id}/fix`);
    expect(again).toMatchObject({ status: 400, json: { error: { message: 'Only a run that failed can be fixed.' } } });
  });

  it("Fix with AI on a task's worktree run sends the error back to that task's agent", async () => {
    hh = await setup();
    const t = hh.newTask({ title: 'Add a page' });
    await runAction(hh.ctx, t.id, 'start', {});
    await hh.finish(t.id, implDone());
    await hh.finish(t.id, reviewPass());
    expect(hh.task(t.id).stage).toBe('human_review');

    const run = await failedRun(t.id);
    const busy = hh.task(t.id);
    const r = await call('POST', `/api/project-runs/${run.id}/fix`);
    expect(r.json).toMatchObject({ created: false, task: { id: t.id, stage: 'implementing' }, run: { fixTaskId: t.id } });
    const sent = hh.fake.calls.filter((c) => c.op === 'send').at(-1)!.args as { threadId: string; message: string };
    expect(sent.threadId).toBe(busy.threadId);
    expect(sent.message).toContain('requests changes');
    expect(sent.message).toContain("failed in this task's worktree");

    // While the agent works on it, a second fix is refused.
    const run2 = await failedRun(t.id);
    expect((await call('POST', `/api/project-runs/${run2.id}/fix`)).json.error.code).toBe('ILLEGAL_TRANSITION');
  });
});
