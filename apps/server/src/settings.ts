// Global settings, stored as one JSON value per top-level key in the `settings` table.
import { AppSettings, DEFAULT_APP_SETTINGS, type PatchSettings } from '@t3-orchestra/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { settings } from './db/schema.ts';

export class SettingsStore {
  private cache: AppSettings | null = null;
  private listeners = new Set<(s: AppSettings) => void>();

  constructor(private readonly db: Db) {}

  get(): AppSettings {
    if (this.cache) return this.cache;
    const rows = this.db.select().from(settings).all();
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<AppSettings>;
    const merged = {
      ...DEFAULT_APP_SETTINGS,
      ...stored,
      notifications: { ...DEFAULT_APP_SETTINGS.notifications, ...(stored.notifications ?? {}) },
      boardDefaults: { ...DEFAULT_APP_SETTINGS.boardDefaults, ...(stored.boardDefaults ?? {}) },
    };
    const parsed = AppSettings.safeParse(merged);
    this.cache = parsed.success ? parsed.data : DEFAULT_APP_SETTINGS;
    return this.cache;
  }

  patch(p: PatchSettings): AppSettings {
    const cur = this.get();
    const next = AppSettings.parse({
      ...cur,
      ...p,
      notifications: { ...cur.notifications, ...(p.notifications ?? {}) },
      boardDefaults: { ...cur.boardDefaults, ...(p.boardDefaults ?? {}) },
    });
    this.db.transaction((tx) => {
      for (const key of Object.keys(p) as Array<keyof AppSettings>) {
        const value = next[key];
        const existing = tx.select().from(settings).where(eq(settings.key, key)).get();
        if (existing) tx.update(settings).set({ value }).where(eq(settings.key, key)).run();
        else tx.insert(settings).values({ key, value }).run();
      }
    });
    this.cache = next;
    for (const l of this.listeners) l(next);
    return next;
  }

  onChange(fn: (s: AppSettings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
