// Screenshots an implementer saves for the human reviewer. Each task attempt gets its own folder
// under <dataDir>/screenshots, outside the repo, so nothing ends up in a commit and the images
// outlive the worktree.
import fs from 'node:fs';
import path from 'node:path';
import type { ScreenshotView } from '@t3-orchestra/shared';

export const SCREENSHOT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Shown in the Review tab; anything past this is ignored. */
const MAX_SCREENSHOTS = 12;
const NAME_RE = /^[\w][\w .()-]{0,150}$/;

type TaskRef = { id: string; attempt: number };

export function screenshotDir(dataDir: string, task: TaskRef): string {
  return path.join(dataDir, 'screenshots', task.id, String(task.attempt));
}

/** Absolute path of one screenshot, or null when the name is not a plain image file in the folder. */
export function screenshotPath(dataDir: string, task: TaskRef, name: string): string | null {
  if (!NAME_RE.test(name) || !(path.extname(name).toLowerCase() in SCREENSHOT_TYPES)) return null;
  const file = path.join(screenshotDir(dataDir, task), name);
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

export function listScreenshots(dataDir: string, task: TaskRef): ScreenshotView[] {
  const dir = screenshotDir(dataDir, task);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && NAME_RE.test(e.name) && path.extname(e.name).toLowerCase() in SCREENSHOT_TYPES)
    .flatMap((e) => {
      try {
        return [{ name: e.name, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs }];
      } catch {
        return []; // removed while listing
      }
    })
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
    .slice(0, MAX_SCREENSHOTS)
    .map((s) => ({
      name: s.name,
      url: `/api/tasks/${task.id}/screenshots/${encodeURIComponent(s.name)}?v=${Math.round(s.mtime)}`,
    }));
}
