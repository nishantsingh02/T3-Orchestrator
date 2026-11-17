// Context files live in the project: <project>/.t3orchestra/context/files/<name>, with the knowledge graph
// beside them in graph.json. Committed with the project they come along to another computer, and every
// agent (in any worktree) can read them by absolute path in the root checkout.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { knowledgeFileKind, MAX_KNOWLEDGE_FILE_BYTES } from '@t3-orchestra/shared';

/** The folder in the project, repo-relative. */
export const CONTEXT_FOLDER = '.t3orchestra/context';
/** Its names before the renames (Yardmaster, then T3 Board). Projects that have only one keep using it. */
export const LEGACY_CONTEXT_FOLDERS = ['.yardmaster/context', '.t3board/context'] as const;

/** The folder this project uses, repo-relative. */
export function contextFolder(projectPath: string): string {
  const has = (folder: string) => fs.existsSync(path.join(projectPath, ...folder.split('/')));
  if (has(CONTEXT_FOLDER)) return CONTEXT_FOLDER;
  return LEGACY_CONTEXT_FOLDERS.find(has) ?? CONTEXT_FOLDER;
}

export function contextDir(projectPath: string): string {
  return path.join(projectPath, ...contextFolder(projectPath).split('/'));
}

export function contextFilesDir(projectPath: string): string {
  return path.join(contextDir(projectPath), 'files');
}

export function contextFilePath(projectPath: string, name: string): string {
  return path.join(contextFilesDir(projectPath), name);
}

export function graphFilePath(projectPath: string): string {
  return path.join(contextDir(projectPath), 'graph.json');
}

/** Where files were kept before they moved into the project. */
export function legacyContextDir(dataDir: string, boardId: string): string {
  return path.join(dataDir, 'context', boardId);
}

/** A repo-relative path from `git status` inside the context folder. */
export function isContextPath(p: string): boolean {
  const rel = `${p.replace(/^"/, '').replace(/\\/g, '/')}/`;
  return [CONTEXT_FOLDER, ...LEGACY_CONTEXT_FOLDERS].some((folder) => rel.startsWith(`${folder}/`));
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const MAX_NAME = 120;

/**
 * A safe file name from what the browser sent: the last path segment, without characters Windows or a
 * shell would trip on, no leading dots, at most 120 characters with the extension kept. Null when
 * nothing usable is left.
 */
export function safeFileName(raw: string): string | null {
  let name = (raw.split(/[\\/]/).pop() ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"|?*\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (!name || /^_+$/.test(name)) return null;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name.length > MAX_NAME) {
    const ext = path.extname(name).slice(0, 16);
    name = `${name.slice(0, MAX_NAME - ext.length).trimEnd()}${ext}`;
  }
  return name;
}

/** Writes through a temporary file, so a reader never sees half a file. */
export function writeAtomic(file: string, data: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function writeContextFile(projectPath: string, name: string, data: Uint8Array, sha256: string): string {
  const file = contextFilePath(projectPath, name);
  writeAtomic(file, data);
  remember(file, sha256);
  return file;
}

export function removeContextFile(projectPath: string, name: string): void {
  fs.rmSync(contextFilePath(projectPath, name), { force: true });
}

// Hashes by path, size and modified time: a scan reads only files that changed since it last looked.
const hashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

function remember(file: string, sha256: string): void {
  try {
    const st = fs.statSync(file);
    hashes.set(file, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
  } catch {
    hashes.delete(file);
  }
}

export interface DiskFile {
  name: string;
  size: number;
  sha256: string;
}

/**
 * The files in the project's context folder (no dotfiles, folders or files over the upload limit),
 * hashed; null when the folder doesn't exist.
 */
export function scanContextFiles(projectPath: string): DiskFile[] | null {
  const files = folderFiles(projectPath);
  if (!files) return null;
  const out: DiskFile[] = [];
  for (const { name, file } of files) {
    try {
      const st = fs.statSync(file);
      if (st.size === 0 || st.size > MAX_KNOWLEDGE_FILE_BYTES) continue;
      const seen = hashes.get(file);
      let sha256 = seen && seen.size === st.size && seen.mtimeMs === st.mtimeMs ? seen.sha256 : '';
      if (!sha256) {
        sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        hashes.set(file, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
      }
      out.push({ name, size: st.size, sha256 });
    } catch {
      // Gone while we looked.
    }
  }
  return out;
}

/** The names of the files in the context folder that the scan leaves out for being over the limit. */
export function oversizeContextFiles(projectPath: string): string[] {
  return (folderFiles(projectPath) ?? [])
    .filter(({ file }) => {
      try {
        return fs.statSync(file).size > MAX_KNOWLEDGE_FILE_BYTES;
      } catch {
        return false;
      }
    })
    .map((f) => f.name);
}

/** The files (no dotfiles or folders) in the context folder; null when it doesn't exist. */
function folderFiles(projectPath: string): Array<{ name: string; file: string }> | null {
  const dir = contextFilesDir(projectPath);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, file: path.join(dir, e.name) }));
  } catch {
    return null;
  }
}

/**
 * How the raw route serves a file. Only images and PDFs render as themselves; text of any kind (HTML
 * and SVG sources included) comes back as plain text, and everything else downloads.
 */
export function servedType(name: string): { type: string; inline: boolean } {
  const ext = path.extname(name).toLowerCase();
  const kind = knowledgeFileKind(name);
  if (kind === 'pdf') return { type: 'application/pdf', inline: true };
  if (kind === 'image') {
    const types: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.avif': 'image/avif',
    };
    // SVG can carry scripts: it is shown as its source.
    if (types[ext]) return { type: types[ext], inline: true };
    return { type: 'text/plain; charset=utf-8', inline: true };
  }
  if (kind === 'text') return { type: 'text/plain; charset=utf-8', inline: true };
  return { type: 'application/octet-stream', inline: false };
}
