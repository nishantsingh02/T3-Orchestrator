// Tab title badge: "(n) T3 Orchestra", n = tasks needing attention or human review across loaded boards.
import { useQueryClient } from '@tanstack/react-query';
import type { BoardView } from '@t3-orchestra/shared';
import { useEffect } from 'react';
import { cachedTaskLists } from './cache';
import { keys } from './keys';

export function useTitleBadge(): void {
  const qc = useQueryClient();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const compute = () => {
      timer = null;
      const lists = cachedTaskLists(qc);
      const loaded = new Set(lists.map(([boardId]) => boardId));
      let n = 0;
      for (const [, list] of lists) {
        for (const t of list) {
          if (t.stage !== 'discarded' && (t.attention !== null || t.stage === 'human_review')) n++;
        }
      }
      // Boards whose tasks aren't loaded yet fall back to the server's count.
      for (const b of qc.getQueryData<BoardView[]>(keys.boards) ?? []) {
        if (!loaded.has(b.id)) n += b.counts.needsYou;
      }
      const title = n > 0 ? `(${n}) T3 Orchestra` : 'T3 Orchestra';
      if (document.title !== title) document.title = title;
    };

    compute();
    const unsubscribe = qc.getQueryCache().subscribe(() => {
      timer ??= setTimeout(compute, 150);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [qc]);
}
