// localStorage can throw (private mode, blocked site data) — every access is guarded.

const PREFIX = 't3orchestra:';
/** Prefixes from before the renames (Yardmaster, then T3 Board): their settings still count until saved again. */
const LEGACY_PREFIXES = ['yardmaster:', 't3board:'];

export function readString(key: string): string | null {
  try {
    for (const prefix of [PREFIX, ...LEGACY_PREFIXES]) {
      const value = window.localStorage.getItem(prefix + key);
      if (value !== null) return value;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // ignore
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = readString(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    writeString(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}
