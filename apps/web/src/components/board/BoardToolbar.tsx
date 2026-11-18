import type { BoardView } from '@t3-orchestra/shared';
import { ChartNoAxesColumn, Eye, EyeOff, GitBranch, Lightbulb, ListTodo, Megaphone, MessagesSquare, Milestone, Minus, Network, Plus, Search, Settings2, ShieldCheck, SquareKanban, X, type LucideIcon } from 'lucide-react';
import type { Ref } from 'react';
import { usePatchBoard } from '@/api/boards';
import { useBoardPlans } from '@/api/plans';
import { needsYou } from '@/components/plans/model';
import { OpenGithubButton } from '@/components/run/OpenGithubButton';
import { OpenInVsCodeButton } from '@/components/run/OpenInVsCodeButton';
import { RunButton } from '@/components/run/RunButton';
import { Button } from '@/components/ui/button';
import { Input, Kbd } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { BoardMode } from './BoardContext';

const MODES: Array<{ mode: BoardMode; label: string; icon: LucideIcon }> = [
  { mode: 'board', label: 'Board', icon: SquareKanban },
  { mode: 'plans', label: 'Plans', icon: ListTodo },
  { mode: 'overview', label: 'Overview', icon: ChartNoAxesColumn },
  { mode: 'roadmap', label: 'Roadmap', icon: Milestone },
  { mode: 'insights', label: 'Insights', icon: MessagesSquare },
  { mode: 'ideas', label: 'Ideas', icon: Lightbulb },
  { mode: 'marketing', label: 'Marketing', icon: Megaphone },
  { mode: 'security', label: 'Security', icon: ShieldCheck },
  { mode: 'context', label: 'Context', icon: Network },
];

function ModeSwitch({ board, mode, onMode }: { board: BoardView; mode: BoardMode; onMode: (m: BoardMode) => void }) {
  // The Plans tab counts plans waiting on you (a question in T3, proposals to review).
  const waiting = (useBoardPlans(board.id).data ?? []).filter(needsYou).length;
  // The Security tab counts open critical and high findings nobody has triaged yet.
  const risks = board.securityOpen.critical + board.securityOpen.high;
  return (
    <div role="tablist" aria-label="Board view" className="flex shrink-0 items-center rounded-md border border-border p-0.5">
      {MODES.map((m) => {
        const Icon = m.icon;
        const active = m.mode === mode;
        const badge = m.mode === 'plans' && waiting > 0 ? waiting : m.mode === 'security' && risks > 0 ? risks : null;
        const badgeNote = m.mode === 'security' ? 'critical or high findings open' : 'waiting for you';
        return (
          <button
            key={m.mode}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={badge ? `${m.label} (${badge} ${badgeNote})` : m.label}
            title={badge ? `${m.label}: ${badge} ${badgeNote}` : m.label}
            onClick={() => !active && onMode(m.mode)}
            className={cn(
              'flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5',
              active ? 'bg-secondary text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon />
            {/* Icons only below lg: eight labels crowd out the board name. */}
            <span className="hidden lg:inline">{m.label}</span>
            {badge && (
              <span
                className={cn(
                  'rounded-full px-1.5 font-mono text-[10px] leading-4',
                  m.mode === 'security' ? 'bg-destructive/15 text-destructive' : 'bg-warning/20 text-warning',
                )}
              >
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

interface Props {
  board: BoardView;
  mode: BoardMode;
  onMode: (mode: BoardMode) => void;
  activeCount: number;
  needsYou: number;
  globalActive: number;
  globalMax: number | null;
  pauseAll: boolean;
  filter: string;
  onFilter: (v: string) => void;
  filterRef: Ref<HTMLInputElement>;
  showDiscarded: boolean;
  onToggleDiscarded: () => void;
  discardedCount: number;
  onNewTask: () => void;
  onSettings: () => void;
}

export function BoardToolbar(p: Props) {
  const { board } = p;
  const patch = usePatchBoard();
  const setParallel = (n: number) => {
    const maxParallel = Math.min(20, Math.max(1, n));
    if (maxParallel !== board.maxParallel) patch.mutate({ board, patch: { maxParallel } });
  };
  const over = p.activeCount > board.maxParallel;

  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2.5 pb-1.5">
        {/* The basis makes the buttons wrap below on phones instead of covering the view switch. */}
        <div className="flex min-w-0 flex-1 basis-60 items-baseline gap-2.5">
          <h1 className="max-w-[45%] shrink-0 truncate text-[15px] font-semibold tracking-tight">{board.name}</h1>
          <ModeSwitch board={board} mode={p.mode} onMode={p.onMode} />
          <span className="hidden min-w-0 items-center gap-2 text-xs text-muted-foreground md:flex">
            <span className="truncate font-mono text-[11.5px]" title={board.projectPath}>
              {board.projectPath}
            </span>
            <span className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-px font-mono text-[11px]">
              <GitBranch className="size-3" />
              {board.baseBranch}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <OpenInVsCodeButton board={board} />
          <OpenGithubButton board={board} />
          <RunButton board={board} />
          <Tip content={<span>New task <Kbd>N</Kbd></span>}>
            <Button size="sm" onClick={p.onNewTask}>
              <Plus />
              New task
            </Button>
          </Tip>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 pb-2.5 text-xs">
        <label className="flex items-center gap-2">
          <Switch
            checked={board.autoRun}
            onCheckedChange={(autoRun) => patch.mutate({ board, patch: { autoRun } })}
            aria-label="Auto-run"
          />
          <span className={cn('font-medium', board.autoRun ? 'text-foreground' : 'text-muted-foreground')}>Auto-run</span>
          {board.autoRun && p.pauseAll && <span className="text-warning">(paused globally)</span>}
        </label>

        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Parallel</span>
          <div className="flex items-center rounded-md border border-border">
            <Button
              variant="ghost"
              size="icon-xs"
              className="rounded-r-none"
              onClick={() => setParallel(board.maxParallel - 1)}
              disabled={board.maxParallel <= 1}
              aria-label="Decrease parallel limit"
            >
              <Minus />
            </Button>
            <span className="w-6 text-center font-mono text-xs tabular">{board.maxParallel}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="rounded-l-none"
              onClick={() => setParallel(board.maxParallel + 1)}
              disabled={board.maxParallel >= 20}
              aria-label="Increase parallel limit"
            >
              <Plus />
            </Button>
          </div>
        </div>

        <Tip
          content={
            <span>
              Tasks implementing or in AI review on this board
              {p.globalMax !== null && (
                <>
                  <br />
                  All boards: {p.globalActive}/{p.globalMax}
                </>
              )}
              {over && (
                <>
                  <br />
                  Manual starts ignore the limit.
                </>
              )}
            </span>
          }
        >
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className={cn('size-1.5 rounded-full', p.activeCount > 0 ? 'animate-pulse bg-stage-running' : 'bg-border-strong')} />
            Running{' '}
            <span className={cn('font-mono tabular', over ? 'text-warning' : 'text-foreground')}>
              {p.activeCount}/{board.maxParallel}
            </span>
          </span>
        </Tip>

        <span className={cn('flex items-center gap-1.5', p.needsYou > 0 ? 'text-stage-needs-input' : 'text-muted-foreground')}>
          Needs you:
          <span className={cn('font-mono tabular', p.needsYou > 0 ? 'font-semibold' : 'text-foreground')}>{p.needsYou}</span>
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {p.mode === 'board' && (
            <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={p.filterRef}
                value={p.filter}
                onChange={(e) => p.onFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    p.onFilter('');
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Filter"
                className="h-7 w-44 pr-7 pl-7 text-xs"
                aria-label="Filter tasks"
              />
              {p.filter ? (
                <button
                  type="button"
                  onClick={() => p.onFilter('')}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Clear filter"
                >
                  <X className="size-3" />
                </button>
              ) : (
                <Kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2">/</Kbd>
              )}
            </div>
            <Tip content={p.showDiscarded ? 'Hide discarded tasks' : 'Show discarded tasks'}>
              <Button
                variant={p.showDiscarded ? 'secondary' : 'ghost'}
                size="sm"
                onClick={p.onToggleDiscarded}
                aria-pressed={p.showDiscarded}
              >
                {p.showDiscarded ? <Eye /> : <EyeOff />}
                <span className="hidden lg:inline">Discarded</span>
                {p.discardedCount > 0 && <span className="font-mono text-[10.5px] text-muted-foreground">{p.discardedCount}</span>}
              </Button>
            </Tip>
            </>
          )}
          <Tip content="Board settings">
            <Button variant="ghost" size="icon-sm" onClick={p.onSettings} aria-label="Board settings">
              <Settings2 />
            </Button>
          </Tip>
        </div>
      </div>
    </div>
  );
}
