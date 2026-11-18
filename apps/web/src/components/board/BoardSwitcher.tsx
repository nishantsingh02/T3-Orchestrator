import type { BoardView } from '@t3-orchestra/shared';
import { Check, ChevronsUpDown, LayoutGrid } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useBoards } from '@/api/boards';
import { boardModePath, type BoardMode } from '@/components/board/BoardContext';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/** Breadcrumb board name that opens a menu to jump to another board, keeping the current view. */
export function BoardSwitcher({ board, mode }: { board: BoardView; mode: BoardMode }) {
  const navigate = useNavigate();
  const boards = useBoards().data ?? [];
  const sorted = [...boards].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent">
        <span className="truncate">{board.name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Boards</DropdownMenuLabel>
        {sorted.map((b) => (
          <DropdownMenuItem
            key={b.id}
            onSelect={() => b.id !== board.id && navigate(boardModePath(b.slug, mode))}
          >
            <Check className={cn(b.id !== board.id && 'invisible')} />
            <span className="min-w-0 flex-1 truncate">{b.name}</span>
            {b.counts.needsYou > 0 && (
              <span className="rounded-full bg-warning/20 px-1.5 font-mono text-[10px] leading-4 text-warning">
                {b.counts.needsYou}
              </span>
            )}
            {b.counts.active > 0 && (
              <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                {b.counts.active}
              </span>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/')}>
          <LayoutGrid />
          All boards
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
