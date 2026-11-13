import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** First non-empty line of a block of text, trimmed. */
export function firstLine(text: string | null | undefined): string {
  if (!text) return '';
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/** Splits a textarea value into trimmed, non-empty lines. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Splits a comma- or newline-separated list into trimmed, non-empty entries. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Last path segment of a file-system path (either separator). */
export function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
