// OS-level helpers for project runs: PATH lookup, ports, process trees, console windows.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const pathCache = new Map<string, { found: boolean; at: number }>();
const PATH_TTL_MS = 60_000;

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

/** Is `cmd` an executable on PATH? Reads the file system instead of spawning `where`/`which`. */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  const cached = pathCache.get(cmd);
  if (cached && Date.now() - cached.at < PATH_TTL_MS) return cached.found;
  const win = platform === 'win32';
  const dirs = (env[pathKey(env)] ?? '').split(win ? ';' : ':').filter(Boolean);
  const exts = win ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  let found = false;
  outer: for (const dir of dirs) {
    // The Microsoft Store "python" aliases open the Store instead of running Python.
    if (win && /^python3?$/i.test(cmd) && /[\\/]WindowsApps[\\/]?$/i.test(dir)) continue;
    for (const ext of exts) {
      try {
        const st = fs.statSync(path.join(dir.replace(/^"|"$/g, ''), cmd + ext));
        if (st.isFile()) {
          found = true;
          break outer;
        }
      } catch {
        // not here
      }
    }
  }
  pathCache.set(cmd, { found, at: Date.now() });
  return found;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** `preferred` if free, else the next free port above it, else one the OS picks. */
export async function freePort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 40 && p < 65536; p++) {
    if (await portFree(p)) return p;
  }
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : preferred));
    });
  });
}

/** The environment for the user's program: ours minus what pnpm and T3 Orchestra put there. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    // pnpm/npm write their script variables in lower case (npm_config_*, npm_lifecycle_*); the user's own
    // settings (NPM_CONFIG_REGISTRY, PNPM_HOME) stay.
    // WATCH_REPORT_DEPENDENCIES comes from `node --watch` (the server's `pnpm dev`). Inherited, it makes Node
    // worker threads post module reports to their parent, which pnpm takes for replies: `pnpm install` dies
    // with "Cannot destructure property 'verified'".
    if (/^npm_/.test(k) || /^T3ORCHESTRA_/i.test(k) || ['NODE_ENV', 'INIT_CWD', 'PNPM_SCRIPT_SRC_DIR', 'PNPM_PACKAGE_NAME', 'WATCH_REPORT_DEPENDENCIES'].includes(k.toUpperCase())) continue;
    env[k] = v;
  }
  const key = pathKey(env);
  const sep = process.platform === 'win32' ? ';' : ':';
  // `pnpm dev` puts T3 Orchestra's node_modules/.bin first on PATH; the project should use its own tools.
  env[key] = (env[key] ?? '')
    .split(sep)
    .filter((d) => d && !/[\\/]node_modules[\\/](\.bin|\.pnpm)|node-gyp-bin/i.test(d))
    .join(sep);
  env.BROWSER = 'none'; // dev servers that open a browser tab themselves (CRA): we hand out the link instead
  env.PYTHONUNBUFFERED = '1'; // otherwise piped Python output arrives in big late blocks
  env.PYTHONIOENCODING = 'utf-8';
  return env;
}

/** Kills a process and its children. Resolves once the kill command has run. */
export function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const p = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      p.once('error', () => resolve());
      p.once('exit', () => resolve());
    });
  }
  signalGroup(pid, 'SIGTERM');
  setTimeout(() => signalGroup(pid, 'SIGKILL'), 3000).unref();
  return Promise.resolve();
}

export function killTreeSync(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else signalGroup(pid, 'SIGKILL');
}

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig); // children were spawned detached, so the pid leads a process group
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** ms since epoch */
  startedAt: number;
}

/** Every process on the machine, with its parent and start time (one PowerShell or ps call). */
export function processTable(): Promise<ProcInfo[]> {
  const win = process.platform === 'win32';
  const [cmd, args] = win
    ? [
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToUniversalTime().ToString(\'o\'))" } }',
        ],
      ]
    : ['ps', ['-A', '-o', 'pid=,ppid=,lstart=']];
  return new Promise((resolve) => {
    const p = spawn(cmd, args as string[], { windowsHide: true });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => (out += d));
    p.once('error', () => resolve([]));
    p.once('close', () => {
      const rows: ProcInfo[] = [];
      for (const line of out.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        const t = m ? Date.parse(m[3]!) : NaN;
        if (m && Number.isFinite(t)) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), startedAt: t });
      }
      resolve(rows);
    });
  });
}

/**
 * `root` and everything below it. A child must have started after its parent: Windows keeps a dead
 * parent's pid in ParentProcessId, and that pid may since belong to someone else.
 */
export function descendants(table: ProcInfo[], root: number): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const top = table.find((p) => p.pid === root);
  if (!top) return [];
  const out = [top];
  for (let i = 0; i < out.length; i++) {
    const parent = out[i]!;
    for (const c of byParent.get(parent.pid) ?? []) {
      if (c.pid !== parent.pid && c.startedAt >= parent.startedAt - 1000 && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

/** Start times (ms since epoch) of the given live processes, to tell our old processes from reused pids. */
export function processStartTimes(pids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (pids.length === 0) return out;
  if (process.platform === 'win32') {
    const script = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.StartTime.ToUniversalTime().ToString('o'))" }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
    for (const line of (r.stdout ?? '').split(/\r?\n/)) {
      const [pid, iso] = line.trim().split(' ');
      const t = Date.parse(iso ?? '');
      if (pid && Number.isFinite(t)) out.set(Number(pid), t);
    }
    return out;
  }
  const r = spawnSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 10_000 });
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    const t = m ? Date.parse(m[2]!) : NaN;
    if (m && Number.isFinite(t)) out.set(Number(m[1]), t);
  }
  return out;
}

/**
 * Opens `command` in a new console window (Windows) and returns the window's cmd.exe pid.
 * The command travels in an environment variable, so nothing is re-quoted on the way: cmd expands
 * %T3ORCHESTRA_RUN_CMD% before it parses `&&`, quotes and redirections, exactly as if typed.
 */
export function openConsoleWindow(o: { command: string; cwd: string; title: string; env: NodeJS.ProcessEnv }): Promise<number> {
  const title = o.title.replace(/[^\w .:#()-]/g, '').slice(0, 80) || 'T3 Orchestra';
  const env = { ...o.env, T3ORCHESTRA_RUN_CMD: `title ${title}&& ${o.command}`, T3ORCHESTRA_RUN_CWD: o.cwd };
  const script = "$p = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /k %T3ORCHESTRA_RUN_CMD%' -WorkingDirectory $env:T3ORCHESTRA_RUN_CWD -PassThru; $p.Id";
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, windowsHide: true });
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => (out += d));
    ps.stderr.on('data', (d) => (err += d));
    ps.once('error', reject);
    ps.once('exit', () => {
      const pid = Number(out.trim().split(/\s+/).pop());
      if (Number.isInteger(pid) && pid > 0) resolve(pid);
      else reject(new Error(err.trim() || 'Could not open a console window'));
    });
  });
}

/** Opens `command` in Terminal.app (macOS). T3 Orchestra can't follow or stop it there. */
export function openMacTerminal(command: string, cwd: string): Promise<void> {
  const sh = `cd '${cwd.replace(/'/g, `'\\''`)}' && ${command}`;
  const apple = sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-e', `tell application "Terminal" to do script "${apple}"`, '-e', 'tell application "Terminal" to activate'], { stdio: 'ignore' });
    p.once('error', reject);
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`osascript exited with ${code}`))));
  });
}

/**
 * VS Code's own program on Windows: Code.exe next to the `code` command on PATH, or in a standard install.
 * Started directly rather than through code.cmd, which Node only runs via a shell that re-parses the path.
 */
export function vsCodeExe(env: NodeJS.ProcessEnv = process.env): string | null {
  const win = path.win32;
  const onPathDirs = (env[pathKey(env)] ?? '')
    .split(';')
    .map((d) => d.replace(/^"|"$/g, ''))
    .filter((d) => d && fs.existsSync(win.join(d, 'code.cmd')));
  const installDirs = [env.LOCALAPPDATA && win.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(
    (d): d is string => Boolean(d),
  );
  const candidates = [...onPathDirs.map((d) => win.join(d, '..', 'Code.exe')), ...installDirs.map((d) => win.join(d, 'Microsoft VS Code', 'Code.exe'))];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** Opens `dir` in VS Code on this machine. Resolves false when VS Code isn't installed. */
export function openInVsCode(dir: string): Promise<boolean> {
  // ELECTRON_RUN_AS_NODE (left by an Electron host) would make Code.exe run as plain Node, and VSCODE_*
  // belong to the VS Code window T3 Orchestra may have been started from.
  const env = Object.fromEntries(Object.entries(childEnv()).filter(([k]) => !/^(ELECTRON_RUN_AS_NODE$|VSCODE_)/i.test(k)));
  const mac = process.platform === 'darwin';
  const [cmd, args] =
    process.platform === 'win32'
      ? [vsCodeExe(env), [dir]]
      : mac
        ? ['open', ['-b', 'com.microsoft.VSCode', dir]]
        : [onPath('code', env) ? 'code' : null, [dir]];
  if (!cmd) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, detached: true, stdio: 'ignore' });
    p.once('error', reject);
    if (mac) {
      p.once('exit', (code) => resolve(code === 0)); // `open -b` fails when no app has VS Code's bundle id
    } else {
      p.once('spawn', () => {
        p.unref();
        resolve(true);
      });
    }
  });
}

// ---- output parsing ------------------------------------------------------------------------

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9-]+\.localhost)(?::\d{2,5})?(?:\/[^\s'"<>)\]`]*)?/i;
const PORT_HINTS = [
  /\b(?:Tomcat|Netty|Jetty|Undertow) started on ports?\(?s?\)?:?\s*(\d{2,5})/i,
  /\b(?:listening|running|started|serving|available) (?:on|at) (?:port\s*:?\s*|:)(\d{2,5})\b/i,
];

/** A local URL in one line of output, normalised so a browser can open it (0.0.0.0 → localhost). */
export function extractUrl(line: string): string | null {
  const m = URL_RE.exec(line);
  if (m) {
    return m[0]
      .replace(/[.,;:!?]+$/, '')
      .replace(/^(https?:\/\/)(?:0\.0\.0\.0|\[::\])/i, '$1localhost');
  }
  if (/\bws:\/\/|debugger/i.test(line)) return null;
  for (const re of PORT_HINTS) {
    const p = re.exec(line)?.[1];
    if (p && Number(p) > 0 && Number(p) < 65536) return `http://localhost:${p}/`;
  }
  return null;
}
