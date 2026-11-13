import { useSyncExternalStore } from 'react';

// One shared 1s ticker for every elapsed-time label, instead of an interval per card.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Current time in ms, re-rendering the caller once a second. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
}

export function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Compact duration: "32s", "6m", "1h 4m", "2d 3h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "just now", "5m ago", "3h ago", "2d ago", or a date for older times. */
export function relativeTime(iso: string | null | undefined, nowMs = Date.now()): string {
  const t = toMs(iso);
  if (t === null) return '';
  const diff = nowMs - t;
  if (diff < 45_000) return 'just now';
  if (diff < 7 * 86_400_000) return `${formatDuration(diff)} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function absoluteTime(iso: string | null | undefined): string {
  const t = toMs(iso);
  return t === null ? '' : new Date(t).toLocaleString();
}
