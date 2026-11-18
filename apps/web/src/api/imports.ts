// Imports from T3 Code history ride on the board view (BoardView.projectImport), so there is no
// query of their own: only the toast when one ends while you're not looking at its board.
import type { QueryClient } from '@tanstack/react-query';
import type { BoardView } from '@t3-orchestra/shared';
import type { NavigateFunction } from 'react-router';
import { toast } from 'sonner';
import { keys } from './keys';

export function toastImport(qc: QueryClient, navigate: NavigateFunction, board: BoardView): void {
  const imp = board.projectImport;
  if (!imp || (imp.status !== 'done' && imp.status !== 'failed')) return;
  const before = qc.getQueryData<BoardView>(keys.board(board.id))?.projectImport;
  if (!before || before.id !== imp.id || before.status === imp.status) return;
  // The board's own banner says it already.
  if (window.location.pathname.startsWith(`/b/${board.slug}`)) return;
  const opts = { id: `import:${imp.id}`, duration: 9000, action: { label: 'Open', onClick: () => navigate(`/b/${board.slug}`) } };
  if (imp.status === 'failed') toast.error(`${board.name}: could not learn about the project from T3`, { ...opts, description: imp.error ?? undefined });
  else toast.success(`${board.name}: project context ready`, { ...opts, description: imp.summary ?? undefined });
}
