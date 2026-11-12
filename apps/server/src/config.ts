// Process-level configuration: data dir, ports, flags (spec §10, §16, §17).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  dataDir: string;
  dbPath: string;
  logsDir: string;
  promptsOverrideDir: string;
  host: '127.0.0.1';
  port: number;
  /** Where the browser should go (desktop-toast click-through). Vite in dev, the server otherwise. */
  publicUrl: string;
  fakeT3: boolean;
  t3Home: string;
  isDev: boolean;
  webDistDir: string | null;
}

/** `T3ORCHESTRA_<name>`, or `YARDMASTER_<name>` / `T3BOARD_<name>` from before the renames. */
export function env(name: string): string | undefined {
  return process.env[`T3ORCHESTRA_${name}`] ?? process.env[`YARDMASTER_${name}`] ?? process.env[`T3BOARD_${name}`];
}

function dataDirNamed(name: string): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, name);
  }
  return path.join(os.homedir(), `.${name}`);
}

export function defaultDataDir(): string {
  const home = env('HOME');
  return home ? path.resolve(home) : dataDirNamed('t3orchestra');
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const fakeT3 = overrides.fakeT3 ?? env('FAKE_T3') === '1';
  // Fake mode keeps its boards apart from real ones unless T3ORCHESTRA_HOME says otherwise.
  const dataDir = overrides.dataDir ?? (fakeT3 && !env('HOME') ? `${defaultDataDir()}-fake` : defaultDataDir());
  const port = Number(env('PORT') ?? 4417);
  const isDev = process.env.NODE_ENV !== 'production';
  const webPort = Number(env('WEB_PORT') ?? 5173);
  return {
    ...dataPaths(dataDir),
    host: '127.0.0.1',
    port,
    publicUrl: env('PUBLIC_URL') ?? (isDev ? `http://localhost:${webPort}` : `http://127.0.0.1:${port}`),
    fakeT3,
    t3Home: process.env.T3CODE_HOME ?? path.join(os.homedir(), '.t3'),
    isDev,
    webDistDir: null,
    ...overrides,
  };
}

/**
 * Picks up the data from before the renames: a `yardmaster` folder (or the older `t3-board`) moves to the
 * default one, and its `yardmaster.sqlite` (or `t3board.sqlite`) becomes `t3orchestra.sqlite`. Called once
 * at startup. Whatever can't be moved yet (another copy still has the database open, or its write-ahead
 * log is still there) is used where it is, and moves on a later start.
 */
export function adoptPreRenameData(config: Config, legacyDir: string | null = env('HOME') ? null : preRenameDataDir(config.fakeT3)): Config {
  let dataDir = config.dataDir;
  if (legacyDir && !fs.existsSync(dataDir) && fs.existsSync(legacyDir)) {
    try {
      fs.renameSync(legacyDir, dataDir);
    } catch {
      dataDir = legacyDir;
    }
  }
  const moved = dataDir === config.dataDir ? config : { ...config, ...dataPaths(dataDir) };
  for (const name of ['yardmaster.sqlite', 't3board.sqlite']) {
    const legacyDb = path.join(dataDir, name);
    if (fs.existsSync(moved.dbPath) || !fs.existsSync(legacyDb)) continue;
    // Renaming the database without its -wal file would lose what the log still holds.
    if (!fs.existsSync(`${legacyDb}-wal`)) {
      try {
        fs.renameSync(legacyDb, moved.dbPath);
        return moved;
      } catch {
        // still open somewhere: use it under its old name
      }
    }
    return { ...moved, dbPath: legacyDb };
  }
  return moved;
}

/** The data folder of the previous name, if it is still there. */
function preRenameDataDir(fake: boolean): string {
  for (const name of ['yardmaster', 't3-board']) {
    const dir = `${dataDirNamed(name)}${fake ? '-fake' : ''}`;
    if (fs.existsSync(dir)) return dir;
  }
  return `${dataDirNamed('yardmaster')}${fake ? '-fake' : ''}`;
}

function dataPaths(dataDir: string): Pick<Config, 'dataDir' | 'dbPath' | 'logsDir' | 'promptsOverrideDir'> {
  return {
    dataDir,
    dbPath: path.join(dataDir, 't3orchestra.sqlite'),
    logsDir: path.join(dataDir, 'logs'),
    promptsOverrideDir: path.join(dataDir, 'prompts'),
  };
}
