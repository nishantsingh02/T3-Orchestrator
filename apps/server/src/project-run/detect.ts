// "Run project" detection: looks at a directory and proposes ways to run it, best first.
// Pure file reads; the few facts about the machine (tools on PATH, free ports) come from DetectEnv.
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectKind, RunMode, RunRecipe, RunStep } from '@t3-orchestra/shared';

export interface DetectEnv {
  platform: NodeJS.Platform;
  /** Is this command on PATH? */
  has(cmd: string): Promise<boolean>;
  /** A free TCP port, `preferred` if possible. */
  port(preferred: number): Promise<number>;
  /** Where compiled output goes, outside the repo (a build in the worktree would show up as changes). */
  buildDir: string;
}

type Candidate = RunRecipe & { score: number };

/** Root results at or above this skip the look into subfolders. */
const STRONG = 60;
const MAX_RECIPES = 8;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'bin', 'obj', 'vendor', 'coverage', 'tmp', 'temp',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.venv', 'venv', 'env', '__pycache__', '.idea', '.vscode',
]);
/** Folders whose children are often the real projects (monorepos, .NET solutions). */
const CONTAINERS = new Set(['apps', 'packages', 'services', 'src', 'projects']);

// ---- small helpers -----------------------------------------------------------

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readText(p: string, max = 256 * 1024): string | null {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(max);
      const n = fs.readSync(fd, buf, 0, max, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readJson(p: string): Record<string, any> | null {
  const t = readText(p, 2 * 1024 * 1024);
  if (t === null) return null;
  try {
    const v = JSON.parse(t.replace(/^﻿/, ''));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function list(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Characters a shell would still expand inside double quotes; such paths are skipped, not escaped. */
const UNSAFE_PATH = /[%$`"!\r\n]/;

/** Quotes a path for cmd.exe and sh alike. */
export function q(p: string): string {
  return /^[\w./\\:@+-]+$/.test(p) ? p : `"${p}"`;
}

const posix = (p: string) => p.split(path.sep).join('/');

/** `./name` on POSIX, `name` on Windows (cmd looks in the current directory first). */
function local(env: DetectEnv, file: string): string {
  return env.platform === 'win32' ? file : `./${file}`;
}

function exe(env: DetectEnv, p: string): string {
  return env.platform === 'win32' ? `${p}.exe` : p;
}

async function missing(env: DetectEnv, cmd: string, hint = ''): Promise<string | null> {
  return (await env.has(cmd)) ? null : `${cmd} isn't on PATH${hint ? ` (${hint})` : ''}.`;
}

interface Ctx {
  env: DetectEnv;
  /** The run's root directory. */
  root: string;
  /** Directory being looked at, and its path relative to root ('' = root). */
  dir: string;
  rel: string;
  /** Subtracted from scores below the root. */
  penalty: number;
  out: Candidate[];
}

function add(
  c: Ctx,
  r: {
    id: string;
    label: string;
    kind: ProjectKind;
    mode?: RunMode;
    steps: RunStep[];
    reason: string;
    score: number;
    url?: string | null;
    warning?: string | null;
    stop?: string;
  },
): void {
  const mode = r.mode ?? (r.kind === 'console' ? 'terminal' : 'background');
  c.out.push({
    ...(r.stop ? { stop: r.stop } : {}),
    id: `${r.id}:${c.rel || '.'}`,
    label: r.label,
    kind: r.kind,
    mode,
    cwd: c.rel,
    steps: r.steps,
    reason: c.rel ? `${r.reason} (in ${c.rel})` : r.reason,
    url: r.url ?? null,
    source: 'detected',
    warning: r.warning ?? null,
    score: r.score - c.penalty,
  });
}

const step = (label: string, command: string): RunStep => ({ label, command });

/** `docker compose -f x.yml up -d` → `docker compose -f x.yml down`: what ends the containers a command starts. */
export function composeDown(command: string): string | undefined {
  const m = /\b(docker-compose|docker\s+compose)((?:\s+--?[\w-]+(?:[=\s]+(?!up\b)[^\s&|;-][^\s&|;]*)?)*)\s+up\b/.exec(command);
  return m ? `${m[1]!.replace(/\s+/, ' ')}${m[2]} down` : undefined;
}

// ---- Node ------------------------------------------------------------------------

const WEB_FRAMEWORKS: Array<[dep: string, name: string]> = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['astro', 'Astro'],
  ['@remix-run/dev', 'Remix'],
  ['@react-router/dev', 'React Router'],
  ['gatsby', 'Gatsby'],
  ['@angular/core', 'Angular'],
  ['react-scripts', 'Create React App'],
  ['@vue/cli-service', 'Vue CLI'],
  ['expo', 'Expo'],
  ['@docusaurus/core', 'Docusaurus'],
  ['vitepress', 'VitePress'],
  ['vite', 'Vite'],
  ['parcel', 'Parcel'],
  ['webpack-dev-server', 'webpack'],
];
const NODE_SERVERS: Array<[dep: string, name: string]> = [
  ['@nestjs/core', 'NestJS'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['koa', 'Koa'],
  ['hono', 'Hono'],
  ['@hapi/hapi', 'hapi'],
];

type Pm = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Package manager from `packageManager` or a lockfile, looking from `dir` up to `root`. */
function packageManager(dir: string, root: string): Pm {
  for (let d = dir; ; d = path.dirname(d)) {
    const field = readJson(path.join(d, 'package.json'))?.packageManager;
    if (typeof field === 'string') {
      const name = field.split('@')[0];
      if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
    }
    if (isFile(path.join(d, 'pnpm-lock.yaml'))) return 'pnpm';
    if (isFile(path.join(d, 'yarn.lock'))) return 'yarn';
    if (isFile(path.join(d, 'bun.lockb')) || isFile(path.join(d, 'bun.lock'))) return 'bun';
    if (isFile(path.join(d, 'package-lock.json'))) return 'npm';
    if (path.resolve(d) === path.resolve(root) || path.dirname(d) === d) return 'npm';
  }
}

function hasNodeModules(dir: string, root: string): boolean {
  for (let d = dir; ; d = path.dirname(d)) {
    const nm = path.join(d, 'node_modules');
    // A pnpm install that failed leaves .pnpm behind; .modules.yaml is written once it finishes.
    if (isDir(nm) && !(isDir(path.join(nm, '.pnpm')) && !isFile(path.join(nm, '.modules.yaml')))) return true;
    if (path.resolve(d) === path.resolve(root) || path.dirname(d) === d) return false;
  }
}

function runScript(pm: Pm, script: string, args = ''): string {
  const extra = args ? (pm === 'npm' ? ` -- ${args}` : ` ${args}`) : '';
  return `${pm} run ${script}${extra}`;
}

/** The package's way to stop what `script` starts: its own stop script, or the reverse of the `docker compose up` in it. */
function stopScript(pm: Pm, scripts: Record<string, string>, script: string): string | undefined {
  const own = [`${script}:stop`, `stop:${script}`, `${script}:down`, 'stop', 'down'].find((n) => typeof scripts[n] === 'string');
  return own ? runScript(pm, own) : composeDown(scripts[script] ?? '');
}

async function node(c: Ctx): Promise<void> {
  const pkg = readJson(path.join(c.dir, 'package.json'));
  if (!pkg) return;
  const scripts: Record<string, string> = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const deps: Record<string, unknown> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const pm = packageManager(c.dir, c.root);
  const setup: RunStep[] = hasNodeModules(c.dir, c.root) ? [] : [step('Install dependencies', `${pm} install`)];
  const warning = pm === 'npm' ? await missing(c.env, 'npm', 'install Node.js') : await missing(c.env, pm, `corepack enable ${pm}`);
  const pick = (...names: string[]) => names.find((n) => typeof scripts[n] === 'string');

  // Desktop apps first: their dev script opens a window.
  const tauriScript = Object.keys(scripts).find((n) => /\btauri\s+dev\b/.test(scripts[n]!));
  if (deps['@tauri-apps/cli'] && (tauriScript || scripts.tauri)) {
    const cmd = tauriScript ? runScript(pm, tauriScript) : runScript(pm, 'tauri', 'dev');
    add(c, { id: 'node:tauri', label: 'Tauri app', kind: 'app', steps: [...setup, step('Start the app', cmd)], reason: 'Tauri project', score: 90, warning });
  }
  if (deps.electron) {
    const s = pick('dev', 'start', 'electron:dev', 'electron');
    if (s) {
      add(c, {
        id: `node:electron:${s}`,
        label: 'Electron app',
        kind: 'app',
        steps: [...setup, step('Start the app', runScript(pm, s))],
        reason: `Electron project with a "${s}" script`,
        score: 89,
        warning,
      });
    }
  }

  const framework = WEB_FRAMEWORKS.find(([d]) => deps[d]);
  const server = NODE_SERVERS.find(([d]) => deps[d]);
  const webScript = pick('dev', 'start', 'serve', 'develop', 'dev:web', 'web');
  if (framework && webScript) {
    add(c, {
      id: `node:web:${webScript}`,
      label: `${framework[1]} dev server`,
      kind: 'web',
      steps: [...setup, step('Start the dev server', runScript(pm, webScript))],
      reason: `uses ${framework[1]}, "${webScript}" script`,
      score: 88,
      warning,
      stop: stopScript(pm, scripts, webScript),
    });
  } else if (server && webScript) {
    add(c, {
      id: `node:server:${webScript}`,
      label: `${server[1]} server`,
      kind: 'web',
      steps: [...setup, step('Start the server', runScript(pm, webScript))],
      reason: `uses ${server[1]}, "${webScript}" script`,
      score: 80,
      warning,
      stop: stopScript(pm, scripts, webScript),
    });
  } else if (webScript) {
    // No framework we know: a dev/start script is still the author's way to run it.
    add(c, {
      id: `node:script:${webScript}`,
      label: `${pm} run ${webScript}`,
      kind: webScript === 'start' ? 'console' : 'web',
      mode: 'background',
      steps: [...setup, step(`Run "${webScript}"`, runScript(pm, webScript))],
      reason: `package.json has a "${webScript}" script`,
      score: 72,
      warning,
      stop: stopScript(pm, scripts, webScript),
    });
  }

  // Also offer the other obvious scripts, ranked lower.
  for (const s of ['dev', 'start', 'preview', 'serve']) {
    if (typeof scripts[s] !== 'string' || s === webScript) continue;
    add(c, {
      id: `node:script:${s}`,
      label: `${pm} run ${s}`,
      kind: framework || server ? 'web' : 'console',
      mode: 'background',
      steps: [...setup, step(`Run "${s}"`, runScript(pm, s))],
      reason: `package.json has a "${s}" script`,
      score: 50,
      warning,
      stop: stopScript(pm, scripts, s),
    });
  }

  const library = ['peerDependencies', 'exports', 'module', 'types', 'typings', 'files'].some((k) => k in pkg);
  if (!webScript && !library) {
    const main = [typeof pkg.main === 'string' ? pkg.main : null, 'index.js', 'server.js', 'app.js', 'main.js', 'index.mjs']
      .filter((f): f is string => Boolean(f) && !UNSAFE_PATH.test(f!))
      .find((f) => isFile(path.join(c.dir, f)));
    if (main) {
      add(c, {
        id: 'node:main',
        label: `node ${posix(main)}`,
        kind: server ? 'web' : 'console',
        steps: [...setup, step('Run', `node ${q(main)}`)],
        reason: `Node project, entry ${posix(main)}`,
        score: 45,
        warning: await missing(c.env, 'node', 'install Node.js'),
      });
    }
  }
}

// ---- Python ------------------------------------------------------------------------

async function python(c: Ctx): Promise<string> {
  for (const base of [c.dir, c.root]) {
    for (const v of ['.venv', 'venv', 'env']) {
      const p = c.env.platform === 'win32' ? path.join(base, v, 'Scripts', 'python.exe') : path.join(base, v, 'bin', 'python');
      if (isFile(p) && !UNSAFE_PATH.test(p)) return q(p);
    }
  }
  if (isFile(path.join(c.dir, 'uv.lock')) && (await c.env.has('uv'))) return 'uv run python';
  if (isFile(path.join(c.dir, 'poetry.lock')) && (await c.env.has('poetry'))) return 'poetry run python';
  if (c.env.platform === 'win32') return (await c.env.has('py')) ? 'py' : 'python';
  return (await c.env.has('python3')) ? 'python3' : 'python';
}

/** The app object (`app = FastAPI()`) or factory (`def create_app() -> FastAPI`) a server should load. */
function appTarget(src: string, cls: 'FastAPI' | 'Flask'): { name: string; factory: boolean } | null {
  const direct = new RegExp(`^(\\w+)\\s*(?::[^=\\n]+)?=\\s*${cls}\\(`, 'm').exec(src);
  if (direct) return { name: direct[1]!, factory: false };
  const factory =
    new RegExp(`^def\\s+(\\w+)\\s*\\([^)]*\\)\\s*->\\s*${cls}\\b`, 'm').exec(src)?.[1] ??
    /^def\s+(create_app|make_app|get_app|app_factory)\s*\(/m.exec(src)?.[1];
  if (!factory) return null;
  // `app = create_app()` at module level is an app object after all.
  const built = new RegExp(`^(\\w+)\\s*=\\s*${factory}\\(`, 'm').exec(src);
  return built ? { name: built[1]!, factory: false } : { name: factory, factory: true };
}

const PY_ENTRIES = ['app.py', 'main.py', 'server.py', 'run.py', 'streamlit_app.py', 'gui.py', 'game.py', 'bot.py', '__main__.py'];
const PY_GUI = /^\s*(?:import|from)\s+(tkinter|customtkinter|PyQt[56]|PySide[26]|pygame|kivy|wx|arcade|pyglet|flet|dearpygui)\b/m;

async function pythonProject(c: Ctx): Promise<void> {
  const files = list(c.dir);
  const pyFiles = files.filter((f) => f.endsWith('.py'));
  const isProject = pyFiles.length > 0 || ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'].some((f) => files.includes(f));
  if (!isProject) return;
  const py = await python(c);
  const bare = py === 'py' || py === 'python' || py === 'python3' ? py : null;
  const warning = bare ? await missing(c.env, bare, 'install Python') : null;

  if (files.includes('manage.py')) {
    const port = await c.env.port(8000);
    add(c, {
      id: 'py:django',
      label: 'Django dev server',
      kind: 'web',
      steps: [step('Start the dev server', `${py} manage.py runserver 127.0.0.1:${port}`)],
      reason: 'Django project (manage.py)',
      url: `http://127.0.0.1:${port}/`,
      score: 86,
      warning,
    });
  }

  const entries = [...PY_ENTRIES, ...['src/main.py', 'src/app.py', 'app/main.py']].filter((f) => isFile(path.join(c.dir, f)));
  if (entries.length === 0 && pyFiles.length === 1) entries.push(pyFiles[0]!);
  for (const [i, file] of entries.entries()) {
    if (UNSAFE_PATH.test(file)) continue;
    const src = readText(path.join(c.dir, file)) ?? '';
    const mod = file.replace(/\.py$/, '').split('/').join('.');
    const rank = -i; // earlier names in PY_ENTRIES are likelier entry points
    if (/^\s*(?:import|from)\s+streamlit\b/m.test(src)) {
      const port = await c.env.port(8501);
      add(c, {
        id: `py:streamlit:${file}`,
        label: 'Streamlit app',
        kind: 'web',
        steps: [step('Start Streamlit', `${py} -m streamlit run ${q(file)} --server.port ${port} --server.headless true`)],
        reason: `${file} imports streamlit`,
        url: `http://localhost:${port}/`,
        score: 82 + rank,
        warning,
      });
      continue;
    }
    if (/^\s*(?:import|from)\s+gradio\b/m.test(src)) {
      add(c, { id: `py:gradio:${file}`, label: 'Gradio app', kind: 'web', steps: [step('Run', `${py} ${q(file)}`)], reason: `${file} imports gradio`, score: 80 + rank, warning });
      continue;
    }
    const fastapi = /\bFastAPI\(/.test(src) ? appTarget(src, 'FastAPI') : null;
    if (fastapi) {
      if (/\buvicorn\.run\(/.test(src)) {
        add(c, { id: `py:fastapi:${file}`, label: 'FastAPI app', kind: 'web', steps: [step('Run', `${py} ${q(file)}`)], reason: `${file} creates a FastAPI app and starts uvicorn`, score: 81 + rank, warning });
      } else {
        const port = await c.env.port(8000);
        add(c, {
          id: `py:fastapi:${file}`,
          label: 'FastAPI app',
          kind: 'web',
          steps: [step('Start uvicorn', `${py} -m uvicorn ${fastapi.factory ? '--factory ' : ''}${mod}:${fastapi.name} --port ${port}`)],
          reason: `${file} creates a FastAPI app`,
          url: `http://127.0.0.1:${port}/docs`,
          score: 81 + rank,
          warning,
        });
      }
      continue;
    }
    const flask = /\bFlask\(/.test(src) ? appTarget(src, 'Flask') : null;
    if (flask) {
      if (/^\s*\w+\.run\(/m.test(src)) {
        add(c, { id: `py:flask:${file}`, label: 'Flask app', kind: 'web', steps: [step('Run', `${py} ${q(file)}`)], reason: `${file} creates and runs a Flask app`, score: 81 + rank, warning });
      } else {
        const port = await c.env.port(5000);
        add(c, {
          id: `py:flask:${file}`,
          label: 'Flask app',
          kind: 'web',
          steps: [step('Start Flask', `${py} -m flask --app ${flask.factory ? mod : `${mod}:${flask.name}`} run --port ${port}`)],
          reason: `${file} creates a Flask app`,
          url: `http://127.0.0.1:${port}/`,
          score: 81 + rank,
          warning,
        });
      }
      continue;
    }
    const gui = PY_GUI.exec(src);
    if (gui) {
      add(c, { id: `py:gui:${file}`, label: `${file} (${gui[1]})`, kind: 'app', steps: [step('Run', `${py} ${q(file)}`)], reason: `${file} uses ${gui[1]}`, score: 72 + rank, warning });
      continue;
    }
    add(c, {
      id: `py:script:${file}`,
      label: `python ${file}`,
      kind: 'console',
      steps: [step('Run', `${py} ${q(file)}`)],
      reason: /__name__\s*==\s*['"]__main__['"]/.test(src) ? `${file} has a __main__ block` : `Python entry file ${file}`,
      score: 52 + rank,
      warning,
    });
  }
}

async function notebooks(c: Ctx): Promise<void> {
  const nbs = list(c.dir).filter((f) => f.endsWith('.ipynb'));
  if (nbs.length === 0) return;
  let cmd: string;
  let warning: string | null = null;
  if (await c.env.has('jupyter-lab')) cmd = 'jupyter lab --no-browser';
  else if (await c.env.has('jupyter')) cmd = 'jupyter notebook --no-browser';
  else {
    cmd = `${await python(c)} -m jupyterlab --no-browser`;
    warning = "Jupyter isn't on PATH (pip install jupyterlab).";
  }
  add(c, {
    id: 'py:jupyter',
    label: 'Jupyter',
    kind: 'web',
    steps: [step('Start Jupyter', cmd)],
    reason: nbs.length === 1 ? `notebook ${nbs[0]}` : `${nbs.length} notebooks`,
    score: 58,
    warning,
  });
}

// ---- Rust, Go, .NET, Java ------------------------------------------------------------

async function rust(c: Ctx): Promise<void> {
  const toml = readText(path.join(c.dir, 'Cargo.toml'));
  if (toml === null) return;
  if (!/^\s*\[package\]/m.test(toml) && !/^\s*\[workspace\]/m.test(toml)) return;
  const dep = (re: RegExp) => new RegExp(`^\\s*(${re.source})\\s*=`, 'm').exec(toml)?.[1];
  const web = dep(/axum|actix-web|rocket|warp|poem|tide|salvo/);
  const gui = dep(/bevy|eframe|egui|iced|winit|macroquad|ggez|slint|fltk|gtk4?|druid|tauri|sdl2|minifb|pixels/);
  const kind: ProjectKind = web ? 'web' : gui ? 'app' : 'console';
  add(c, {
    id: 'rust:cargo',
    label: web ? `Rust server (${web})` : gui ? `Rust app (${gui})` : 'cargo run',
    kind,
    steps: [step('Build and run', 'cargo run')],
    reason: web || gui ? `Cargo project using ${web ?? gui}` : 'Cargo project',
    score: 76,
    warning: await missing(c.env, 'cargo', 'install Rust from rustup.rs'),
  });
}

function goKind(src: string): ProjectKind {
  if (/fyne\.io|gioui\.org|hajimehoshi\/ebiten|raylib-go|wailsapp/.test(src)) return 'app';
  if (/"net\/http"|gin-gonic|labstack\/echo|gofiber|go-chi|gorilla\/mux/.test(src)) return 'web';
  return 'console';
}

async function go(c: Ctx): Promise<void> {
  if (!isFile(path.join(c.dir, 'go.mod'))) return;
  const warning = await missing(c.env, 'go', 'install Go from go.dev');
  const srcOf = (d: string) =>
    list(d)
      .filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
      .map((f) => readText(path.join(d, f), 64 * 1024) ?? '')
      .join('\n');
  const targets: string[] = [];
  if (/^package\s+main\b/m.test(srcOf(c.dir))) targets.push('.');
  for (const name of list(path.join(c.dir, 'cmd')).slice(0, 4)) {
    if (!UNSAFE_PATH.test(name) && isFile(path.join(c.dir, 'cmd', name, 'main.go'))) targets.push(`./cmd/${name}`);
  }
  for (const [i, t] of targets.entries()) {
    const kind = goKind(srcOf(path.join(c.dir, t)));
    add(c, {
      id: `go:${t}`,
      label: `go run ${t}`,
      kind,
      steps: [step('Build and run', `go run ${q(t)}`)],
      reason: t === '.' ? 'Go module with package main' : `Go command in ${t.slice(2)}`,
      score: 76 - i,
      warning,
    });
  }
}

async function dotnet(c: Ctx): Promise<void> {
  const projects = list(c.dir).filter((f) => /\.(cs|fs|vb)proj$/.test(f) && !UNSAFE_PATH.test(f));
  for (const file of projects.slice(0, 3)) {
    const xml = readText(path.join(c.dir, file)) ?? '';
    if (/<OutputType>\s*Library\s*<\/OutputType>/i.test(xml) || /<IsTestProject>\s*true/i.test(xml)) continue;
    const web = /Sdk="Microsoft\.NET\.Sdk\.(Web|BlazorWebAssembly)/i.test(xml);
    const app = /<Use(WPF|WindowsForms|Maui)>\s*true|Avalonia|Sdk="Microsoft\.NET\.Sdk\.WindowsDesktop/i.test(xml);
    const kind: ProjectKind = web ? 'web' : app ? 'app' : 'console';
    add(c, {
      id: `dotnet:${file}`,
      label: web ? `ASP.NET app (${file})` : app ? `Desktop app (${file})` : `dotnet run (${file})`,
      kind,
      steps: [step('Build and run', projects.length > 1 ? `dotnet run --project ${q(file)}` : 'dotnet run')],
      reason: `.NET project ${file}`,
      score: 76,
      warning: await missing(c.env, 'dotnet', 'install the .NET SDK'),
    });
  }
}

async function java(c: Ctx): Promise<void> {
  const files = list(c.dir);
  const win = c.env.platform === 'win32';
  const pom = files.includes('pom.xml') ? (readText(path.join(c.dir, 'pom.xml')) ?? '') : null;
  if (pom !== null) {
    const wrapper = files.includes(win ? 'mvnw.cmd' : 'mvnw');
    const mvn = wrapper ? local(c.env, win ? 'mvnw.cmd' : 'mvnw') : 'mvn';
    const warning = wrapper ? null : await missing(c.env, 'mvn', 'install Maven');
    if (/spring-boot/.test(pom)) {
      add(c, { id: 'java:spring-maven', label: 'Spring Boot app', kind: 'web', steps: [step('Start', `${mvn} spring-boot:run`)], reason: 'Maven project using Spring Boot', score: 78, warning });
    } else if (/exec-maven-plugin/.test(pom)) {
      add(c, { id: 'java:maven-exec', label: 'mvn exec:java', kind: 'console', steps: [step('Build and run', `${mvn} -q compile exec:java`)], reason: 'Maven project with exec-maven-plugin', score: 66, warning });
    }
  }
  const gradleFile = ['build.gradle.kts', 'build.gradle'].find((f) => files.includes(f));
  const android = ['settings.gradle', 'settings.gradle.kts', gradleFile, 'app/build.gradle', 'app/build.gradle.kts'].some(
    (f) => f && /com\.android\./.test(readText(path.join(c.dir, f), 64 * 1024) ?? ''),
  );
  if (android) return; // runs on a device or an emulator, not here
  if (gradleFile) {
    const g = readText(path.join(c.dir, gradleFile)) ?? '';
    const wrapper = files.includes(win ? 'gradlew.bat' : 'gradlew');
    const gradle = wrapper ? local(c.env, win ? 'gradlew.bat' : 'gradlew') : 'gradle';
    const warning = wrapper ? null : await missing(c.env, 'gradle', 'install Gradle');
    if (/org\.springframework\.boot/.test(g)) {
      add(c, { id: 'java:spring-gradle', label: 'Spring Boot app', kind: 'web', steps: [step('Start', `${gradle} bootRun`)], reason: 'Gradle project using Spring Boot', score: 78, warning });
    } else if (/\bid\s*\(?\s*["']application["']|apply\s+plugin:\s*["']application["']|^\s*application\s*\{/m.test(g)) {
      add(c, { id: 'java:gradle-run', label: 'gradle run', kind: 'console', steps: [step('Build and run', `${gradle} run`)], reason: 'Gradle project with the application plugin', score: 66, warning });
    }
  }
  if (pom === null && !gradleFile) {
    const main = files.find((f) => f.endsWith('.java') && !UNSAFE_PATH.test(f) && /public\s+static\s+void\s+main\s*\(/.test(readText(path.join(c.dir, f), 64 * 1024) ?? ''));
    if (main) {
      add(c, { id: `java:file:${main}`, label: `java ${main}`, kind: 'console', steps: [step('Run', `java ${q(main)}`)], reason: `${main} has a main method`, score: 56, warning: await missing(c.env, 'java', 'install a JDK (11+)') });
    }
  }
}

// ---- C and C++ -------------------------------------------------------------------------

const C_GUI = /#\s*include\s*[<"](windows\.h|SDL2?\/SDL\.h|SDL\.h|raylib\.h|GLFW\/glfw3\.h|gtk\/gtk\.h|SFML\/)/;

async function firstTool(env: DetectEnv, tools: string[]): Promise<string | null> {
  for (const t of tools) if (await env.has(t)) return t;
  return null;
}

async function cmake(c: Ctx): Promise<boolean> {
  const txt = readText(path.join(c.dir, 'CMakeLists.txt'));
  if (txt === null) return false;
  const project = /project\s*\(\s*([\w-]+)/i.exec(txt)?.[1];
  const targets = [...txt.matchAll(/add_executable\s*\(\s*([\w${}-]+)([^)]*)\)/gi)]
    .map((m) => ({ name: m[1]!.replace(/\$\{PROJECT_NAME\}/g, project ?? ''), win32: /\bWIN32\b/.test(m[2] ?? '') }))
    .filter((t) => /^[\w-]+$/.test(t.name));
  if (targets.length === 0) return false;
  const bd = path.join(c.env.buildDir, 'cmake', posix(c.rel) || '.');
  if (UNSAFE_PATH.test(bd)) return false;
  const warning = await missing(c.env, 'cmake', 'install CMake');
  const gui = /find_package\s*\(\s*(SDL2|raylib|glfw3?|Qt[56]|SFML|wxWidgets|OpenGL)/i.test(txt);
  for (const [i, t] of targets.slice(0, 3).entries()) {
    const out = [path.join(bd, t.name), path.join(bd, 'Debug', t.name), path.join(bd, 'Release', t.name)].map((p) => exe(c.env, p));
    add(c, {
      id: `cmake:${t.name}`,
      label: `${t.name} (CMake)`,
      kind: gui || t.win32 ? 'app' : 'console',
      steps: [
        step('Configure', `cmake -S . -B ${q(bd)}`),
        step('Build', `cmake --build ${q(bd)} --target ${t.name}`),
        { label: 'Run', command: q(out[0]!), candidates: out },
      ],
      reason: `CMake project, executable ${t.name}`,
      score: 72 - i,
      warning,
    });
  }
  return true;
}

async function make(c: Ctx): Promise<boolean> {
  const file = ['Makefile', 'makefile', 'GNUmakefile'].find((f) => isFile(path.join(c.dir, f)));
  if (!file) return false;
  const txt = readText(path.join(c.dir, file)) ?? '';
  const target = ['run', 'dev', 'serve', 'start'].find((t) => new RegExp(`^${t}\\s*:`, 'm').test(txt));
  if (!target) return false;
  const tool = (await firstTool(c.env, c.env.platform === 'win32' ? ['make', 'mingw32-make'] : ['make'])) ?? 'make';
  const stop = ['stop', 'down'].find((t) => new RegExp(`^${t}\\s*:`, 'm').test(txt));
  add(c, {
    id: `make:${target}`,
    label: `${tool} ${target}`,
    kind: 'console',
    mode: target === 'run' ? 'terminal' : 'background',
    steps: [step('Run', `${tool} ${target}`)],
    reason: `Makefile has a "${target}" target`,
    score: 73,
    warning: (await c.env.has(tool)) ? null : `${tool} isn't on PATH.`,
    stop: stop && `${tool} ${stop}`,
  });
  return true;
}

async function cSources(c: Ctx): Promise<void> {
  for (const sub of ['', 'src']) {
    const d = path.join(c.dir, sub);
    const names = list(d).filter((f) => /\.(c|cc|cpp|cxx)$/i.test(f) && !UNSAFE_PATH.test(f)).slice(0, 60);
    if (names.length === 0) continue;
    const srcs = names.map((f) => readText(path.join(d, f), 128 * 1024) ?? '');
    if (!srcs.some((s) => /\b(?:int|void)\s+main\s*\(|\bWinMain\s*\(/.test(s))) continue;
    const cpp = names.some((f) => !/\.c$/i.test(f));
    const tools = cpp ? ['g++', 'clang++', 'c++'] : ['gcc', 'clang', 'cc'];
    const found = await firstTool(c.env, tools);
    const cc = found ?? tools[0]!;
    const name = (path.basename(c.dir).replace(/[^\w-]+/g, '-') || 'program').slice(0, 40);
    const out = exe(c.env, path.join(c.env.buildDir, 'c', posix(c.rel) || '.', name));
    if (UNSAFE_PATH.test(out)) return;
    const files = names.map((f) => q(sub ? `${sub}/${f}` : f)).join(' ');
    const libm = !cpp && c.env.platform !== 'win32' ? ' -lm' : '';
    const gui = srcs.some((s) => C_GUI.test(s));
    add(c, {
      id: `c:${sub || '.'}`,
      label: `${cpp ? 'C++' : 'C'} program (${names.length === 1 ? names[0] : `${names.length} files`})`,
      kind: gui ? 'app' : 'console',
      steps: [step('Compile', `${cc} ${files} -o ${q(out)}${libm}`), { label: 'Run', command: q(out), candidates: [out] }],
      reason: `${cpp ? 'C++' : 'C'} sources with a main function${sub ? ' in src' : ''}`,
      score: 62,
      warning: !found
        ? `No ${cpp ? 'C++' : 'C'} compiler on PATH (${tools.slice(0, 2).join(' or ')}). On Windows, install MSYS2/MinGW-w64 or LLVM.`
        : gui
          ? 'Uses a GUI library; you may need to add linker flags (save your own command).'
          : null,
    });
    return;
  }
}

// ---- Ruby, PHP, Deno, Dart, static, compose, scripts -----------------------------------------

async function ruby(c: Ctx): Promise<void> {
  const files = list(c.dir);
  const warning = files.some((f) => f === 'Gemfile' || f.endsWith('.rb')) ? await missing(c.env, 'ruby', 'install Ruby') : null;
  if (files.includes('Gemfile') && isFile(path.join(c.dir, 'config', 'application.rb'))) {
    const port = await c.env.port(3000);
    const rails = c.env.platform === 'win32' ? 'ruby bin/rails' : 'bin/rails';
    add(c, { id: 'ruby:rails', label: 'Rails server', kind: 'web', steps: [step('Start Rails', `${rails} server -p ${port}`)], reason: 'Rails app', url: `http://127.0.0.1:${port}/`, score: 86, warning });
    return;
  }
  if (files.includes('config.ru')) {
    const port = await c.env.port(9292);
    add(c, { id: 'ruby:rack', label: 'Rack app', kind: 'web', steps: [step('Start', `bundle exec rackup -p ${port}`)], reason: 'config.ru', url: `http://127.0.0.1:${port}/`, score: 72, warning });
    return;
  }
  const main = ['app.rb', 'main.rb', 'server.rb'].find((f) => files.includes(f));
  if (main) {
    const src = readText(path.join(c.dir, main)) ?? '';
    if (/require\s+['"]sinatra/.test(src)) {
      const port = await c.env.port(4567);
      add(c, { id: `ruby:sinatra:${main}`, label: 'Sinatra app', kind: 'web', steps: [step('Run', `ruby ${main} -p ${port}`)], reason: `${main} requires sinatra`, url: `http://127.0.0.1:${port}/`, score: 72, warning });
    } else {
      add(c, { id: `ruby:script:${main}`, label: `ruby ${main}`, kind: 'console', steps: [step('Run', `ruby ${main}`)], reason: `Ruby entry file ${main}`, score: 46, warning });
    }
  }
}

async function php(c: Ctx): Promise<void> {
  const files = list(c.dir);
  if (files.includes('artisan')) {
    const port = await c.env.port(8000);
    add(c, { id: 'php:laravel', label: 'Laravel server', kind: 'web', steps: [step('Start', `php artisan serve --port=${port}`)], reason: 'Laravel app (artisan)', url: `http://127.0.0.1:${port}/`, score: 86, warning: await missing(c.env, 'php', 'install PHP') });
    return;
  }
  const docroot = isFile(path.join(c.dir, 'public', 'index.php')) ? 'public' : isFile(path.join(c.dir, 'index.php')) ? '.' : null;
  if (docroot) {
    const port = await c.env.port(8080);
    add(c, {
      id: 'php:builtin',
      label: 'PHP built-in server',
      kind: 'web',
      steps: [step('Start', `php -S 127.0.0.1:${port} -t ${docroot}`)],
      reason: `${docroot === '.' ? '' : 'public/'}index.php`,
      url: `http://127.0.0.1:${port}/`,
      score: 70,
      warning: await missing(c.env, 'php', 'install PHP'),
    });
  }
}

async function deno(c: Ctx): Promise<void> {
  const file = ['deno.json', 'deno.jsonc'].find((f) => isFile(path.join(c.dir, f)));
  if (!file || isFile(path.join(c.dir, 'package.json'))) return;
  const raw = readText(path.join(c.dir, file)) ?? '';
  const json = readJson(path.join(c.dir, file)) ?? (() => {
    try {
      return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    } catch {
      return {};
    }
  })();
  const tasks: Record<string, unknown> = json.tasks ?? {};
  const task = ['dev', 'start', 'serve'].find((t) => t in tasks);
  const warning = await missing(c.env, 'deno', 'install Deno');
  if (task) {
    add(c, { id: `deno:${task}`, label: `deno task ${task}`, kind: 'web', steps: [step('Run', `deno task ${task}`)], reason: `${file} has a "${task}" task`, score: 80, warning });
  } else {
    const main = ['main.ts', 'mod.ts', 'main.js'].find((f) => isFile(path.join(c.dir, f)));
    if (main) add(c, { id: `deno:${main}`, label: `deno run ${main}`, kind: 'console', steps: [step('Run', `deno run -A ${main}`)], reason: `Deno project, ${main}`, score: 50, warning });
  }
}

async function dart(c: Ctx): Promise<void> {
  const pubspec = readText(path.join(c.dir, 'pubspec.yaml'));
  if (pubspec === null) return;
  if (/^\s*sdk:\s*flutter\b/m.test(pubspec)) {
    const warning = await missing(c.env, 'flutter', 'install Flutter');
    if (c.env.platform === 'win32' && isDir(path.join(c.dir, 'windows'))) {
      add(c, { id: 'flutter:windows', label: 'Flutter app (Windows)', kind: 'app', steps: [step('Run', 'flutter run -d windows')], reason: 'Flutter project with a Windows target', score: 72, warning });
    }
    const port = await c.env.port(8080);
    add(c, { id: 'flutter:web', label: 'Flutter app (Chrome)', kind: 'web', steps: [step('Run', `flutter run -d chrome --web-port ${port}`)], reason: 'Flutter project', score: 70, warning });
  } else if (isFile(path.join(c.dir, 'bin', 'main.dart')) || list(path.join(c.dir, 'bin')).some((f) => f.endsWith('.dart'))) {
    add(c, { id: 'dart:run', label: 'dart run', kind: 'console', steps: [step('Run', 'dart run')], reason: 'Dart package with bin/', score: 56, warning: await missing(c.env, 'dart', 'install Dart') });
  }
}

async function godot(c: Ctx): Promise<void> {
  if (!isFile(path.join(c.dir, 'project.godot'))) return;
  const found = await firstTool(c.env, ['godot', 'godot4']);
  add(c, {
    id: 'godot',
    label: 'Godot game',
    kind: 'app',
    steps: [step('Run', `${found ?? 'godot'} --path .`)],
    reason: 'project.godot',
    score: 74,
    warning: found ? null : 'Godot isn\'t on PATH (add the Godot executable to PATH as "godot").',
  });
}

async function staticSite(c: Ctx): Promise<void> {
  if (isFile(path.join(c.dir, 'package.json'))) return;
  const dirs = c.rel ? [''] : ['', 'public', 'docs', 'site', 'www', 'dist'];
  for (const [i, sub] of dirs.entries()) {
    if (!isFile(path.join(c.dir, sub, 'index.html'))) continue;
    const port = await c.env.port(8080);
    const rel = posix(path.join(c.rel, sub));
    add(c, {
      id: `static:${sub || '.'}`,
      label: 'Static site',
      kind: 'web',
      steps: [{ label: 'Serve files', command: `Built-in static server for ${rel || 'the project root'}`, staticDir: sub || '.' }],
      reason: `${sub ? `${sub}/` : ''}index.html`,
      url: `http://127.0.0.1:${port}/`,
      score: (sub ? 42 : 56) - i,
    });
    return;
  }
}

async function compose(c: Ctx): Promise<void> {
  const file = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find((f) => isFile(path.join(c.dir, f)));
  if (!file) return;
  const txt = readText(path.join(c.dir, file)) ?? '';
  const port = /^\s*-\s*["']?(?:[\d.]+:)?(\d{2,5}):\d{2,5}(?:\/tcp)?["']?\s*$/m.exec(txt)?.[1];
  add(c, {
    id: 'docker:compose',
    label: 'Docker Compose',
    kind: 'web',
    steps: [step('Start containers', 'docker compose up')],
    reason: file,
    url: port ? `http://localhost:${port}/` : null,
    score: 36,
    warning: await missing(c.env, 'docker', 'install Docker Desktop'),
    // Killing `docker compose up` leaves its containers running.
    stop: 'docker compose down',
  });
}

async function procfile(c: Ctx): Promise<void> {
  const txt = readText(path.join(c.dir, 'Procfile'));
  const web = txt && /^web:\s*(.+)$/m.exec(txt)?.[1]?.trim();
  if (!web) return;
  const port = await c.env.port(5000);
  const cmd = web.replace(/\$\{?PORT\}?/g, String(port));
  add(c, { id: 'procfile:web', label: 'Procfile web', kind: 'web', steps: [step('Run', cmd)], reason: 'Procfile "web" process', url: cmd !== web ? `http://localhost:${port}/` : null, score: 50 });
}

async function runScripts(c: Ctx): Promise<void> {
  const files = list(c.dir);
  const win = c.env.platform === 'win32';
  const options: Array<[file: string, cmd: string]> = win
    ? [
        ['run.bat', 'run.bat'],
        ['start.bat', 'start.bat'],
        ['run.cmd', 'run.cmd'],
        ['run.ps1', 'powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1'],
      ]
    : [
        ['run.sh', 'sh run.sh'],
        ['start.sh', 'sh start.sh'],
      ];
  if (win && (await c.env.has('bash'))) options.push(['run.sh', 'bash run.sh'], ['start.sh', 'bash start.sh']);
  const hit = options.find(([f]) => files.includes(f));
  if (!hit) return;
  // stop.bat next to start.bat, stop.sh next to run.sh: run the same way.
  const ext = path.extname(hit[0]);
  const stop = files.includes(`stop${ext}`) ? hit[1].replace(hit[0], `stop${ext}`) : undefined;
  add(c, { id: `script:${hit[0]}`, label: hit[0], kind: 'console', steps: [step('Run', hit[1])], reason: `${hit[0]} in the project`, score: 46, stop });
}

// ---- entry point ----------------------------------------------------------------------

async function detectIn(c: Ctx): Promise<void> {
  await node(c);
  await pythonProject(c);
  await notebooks(c);
  await rust(c);
  await go(c);
  await dotnet(c);
  await java(c);
  const built = (await cmake(c)) || (await make(c));
  if (!built) await cSources(c);
  await ruby(c);
  await php(c);
  await deno(c);
  await dart(c);
  await godot(c);
  await staticSite(c);
  await compose(c);
  await procfile(c);
  await runScripts(c);
}

const FRONTEND = /^node:web:/;
const BACKEND = /^(py:(fastapi|flask|django|gradio)|node:server|go:|rust:|dotnet:|java:spring|ruby:(rails|rack|sinatra)|php:)/;
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** A web frontend in one folder and an API in another, with nothing at the root to start both: start both. */
function frontendAndBackend(sorted: Candidate[]): Candidate | null {
  const front = sorted.find((r) => r.cwd && FRONTEND.test(r.id));
  const back = front && sorted.find((r) => r.cwd && r.kind === 'web' && BACKEND.test(r.id) && !overlaps(r.cwd, front.cwd));
  if (!front || !back) return null;
  const part = (r: Candidate) => ({ label: r.label, cwd: r.cwd, steps: r.steps, url: r.url, kind: r.kind });
  return {
    id: `combo:${front.id}+${back.id}`,
    label: `${front.label} + ${back.label}`,
    kind: 'web',
    mode: 'background',
    cwd: '',
    steps: [],
    parts: [part(front), part(back)],
    reason: `${front.cwd} and ${back.cwd}, side by side`,
    url: front.url,
    source: 'detected',
    warning: front.warning ?? back.warning,
    score: Math.max(front.score, back.score) + 4,
  };
}

function subdirs(dir: string): string[] {
  return list(dir)
    .filter((f) => !f.startsWith('.') && !SKIP_DIRS.has(f) && !UNSAFE_PATH.test(f) && isDir(path.join(dir, f)))
    .slice(0, 40);
}

/** Ways to run the project in `root`, best first. Empty when nothing looks runnable. */
export async function detectRecipes(root: string, env: DetectEnv): Promise<RunRecipe[]> {
  const out: Candidate[] = [];
  const base = { env, root, out };
  await detectIn({ ...base, dir: root, rel: '', penalty: 0 });

  if (!out.some((r) => r.score >= STRONG)) {
    for (const name of subdirs(root)) {
      const dir = path.join(root, name);
      await detectIn({ ...base, dir, rel: name, penalty: 8 });
      if (CONTAINERS.has(name)) {
        for (const child of subdirs(dir).slice(0, 20)) {
          await detectIn({ ...base, dir: path.join(dir, child), rel: `${name}/${child}`, penalty: 12 });
        }
      }
    }
  }

  out.sort((a, b) => b.score - a.score);
  const combo = frontendAndBackend(out);
  if (combo) out.unshift(combo);

  const seen = new Set<string>();
  return out
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .slice(0, MAX_RECIPES)
    .map(({ score: _score, ...r }) => r);
}
