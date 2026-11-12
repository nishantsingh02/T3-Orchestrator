// Notifications (spec §12): dedupe in SQLite, then SSE (in-app toast) + desktop toast.
import type { NotifyType, NotifyView } from '@t3-orchestra/shared';
import { eq } from 'drizzle-orm';
import type { Bus } from '../bus.ts';
import type { Db } from '../db/client.ts';
import { boards, notifications, tasks } from '../db/schema.ts';
import { childLog } from '../log.ts';
import type { SettingsStore } from '../settings.ts';
import { newId, nowIso } from '../util.ts';

const log = childLog('notify');

export interface NotifyInput {
  type: NotifyType;
  boardId: string;
  taskId?: string | null;
  planId?: string | null;
  /** Dedupe discriminator; the key is `type:taskId|planId:discriminator` (spec: `type:taskId:runId`). */
  dedupe: string;
  title: string;
  body?: string;
}

export interface DesktopToast {
  title: string;
  body: string;
  url: string;
  sound: boolean;
}

export type DesktopSink = (t: DesktopToast) => void;

export class Notifier {
  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
    private readonly settings: SettingsStore,
    private readonly publicUrl: () => string,
    private readonly desktop: DesktopSink | null,
  ) {}

  notify(n: NotifyInput): NotifyView | null {
    const s = this.settings.get().notifications;
    if (!s[n.type]) return null;
    const dedupeKey = `${n.type}:${n.taskId ?? n.planId ?? n.boardId}:${n.dedupe}`;
    const row = {
      id: newId(),
      dedupeKey,
      boardId: n.boardId,
      taskId: n.taskId ?? null,
      planId: n.planId ?? null,
      type: n.type,
      title: n.title,
      body: n.body ?? '',
      createdAt: nowIso(),
      readAt: null,
    };
    const inserted = this.db.insert(notifications).values(row).onConflictDoNothing().run();
    if (inserted.changes === 0) return null;

    const board = this.db.select({ slug: boards.slug }).from(boards).where(eq(boards.id, n.boardId)).get();
    const task = n.taskId ? this.db.select({ number: tasks.number }).from(tasks).where(eq(tasks.id, n.taskId)).get() : undefined;
    const view: NotifyView = {
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      boardId: row.boardId,
      boardSlug: board?.slug,
      taskId: row.taskId,
      taskNumber: task?.number ?? null,
      planId: row.planId,
      createdAt: row.createdAt,
    };
    this.bus.emit('notify', view);

    if (s.desktop && this.desktop) {
      let url = this.publicUrl();
      if (board) {
        url += `/b/${board.slug}`;
        if (task) url += `/t/${task.number}`;
        else if (n.planId) url += `/plans/${n.planId}`;
      }
      try {
        this.desktop({ title: view.title, body: view.body || 'T3 Orchestra', url, sound: s.sound });
      } catch (err) {
        log.warn({ err }, 'desktop notification failed');
      }
    }
    return view;
  }
}

/** Desktop toasts through node-notifier; clicking opens the board in the default browser. */
export async function createDesktopSink(): Promise<DesktopSink | null> {
  try {
    const [{ default: notifier }, { default: open }] = await Promise.all([import('node-notifier'), import('open')]);
    return (t) => {
      notifier.notify(
        { title: t.title, message: t.body, sound: t.sound, wait: true, appID: 'T3 Orchestra' } as never,
        (err: Error | null, response: string | undefined, metadata?: { activationType?: string }) => {
          if (err) return;
          const clicked = response === 'activate' || response === 'clicked' || metadata?.activationType === 'clicked';
          if (clicked) void open(t.url).catch(() => undefined);
        },
      );
    };
  } catch (err) {
    log.warn({ err }, 'node-notifier unavailable; desktop notifications disabled');
    return null;
  }
}
