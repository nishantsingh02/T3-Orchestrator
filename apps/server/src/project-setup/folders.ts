// Guards before `git init` commits a folder: not a personal or system folder, and not more files than a
// project plausibly has (the OS folder window starts in Documents, one click away from committing it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Above this many files the first commit needs an explicit yes. */
export const MANY_FILES = 2000;
/** Folders the default .gitignore leaves out, so they don't count. */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', '.next', 'coverage']);
const PERSONAL = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'OneDrive'];

// path.relative ignores case on Windows.
const samePath = (a: string, b: string) => path.relative(a, b) === '';

/** Why `dir` must not become a repository (a drive root, the home folder, Documents…), or null. */
export function protectedFolder(dir: string, home = os.homedir()): string | null {
  const abs = path.resolve(dir);
  if (path.parse(abs).root === abs) return "This is a drive root. Choose the project's own folder.";
  if (samePath(abs, home)) return "This is your home folder. Choose the project's own folder.";
  for (const name of PERSONAL) {
    for (const base of [home, path.join(home, 'OneDrive')]) {
      if (samePath(abs, path.join(base, name))) return `This is your ${name} folder. Choose the project's own folder.`;
    }
  }
  if (process.platform === 'win32') {
    const system = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData];
    if (system.some((s) => s && samePath(abs, s))) return "This is a system folder. Choose the project's own folder.";
  }
  return null;
}

/** Files a first commit would take (folders the default .gitignore covers left out), counted up to MANY_FILES. */
export function countFiles(dir: string): { count: number; more: boolean } {
  let count = 0;
  let visited = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // A wide tree of empty folders is bounded too.
      if (++visited > MANY_FILES * 20) return { count, more: true };
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(path.join(current, e.name));
      } else if (++count > MANY_FILES) {
        return { count: MANY_FILES, more: true };
      }
    }
  }
  return { count, more: false };
}
