// The Marketing dashboard's metrics: one card per connected source with a tile per metric, sources
// found in the project to connect in one click, and a gallery of kinds when nothing is connected yet.
import { SOURCE_KIND_INFO, type BoardView, type MarketingSourceView, type SourceSuggestion } from '@t3-orchestra/shared';
import { Ellipsis, Pencil, Plug, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { useAddSource, useLogValue, useMarketing, useRefreshAll, useRefreshSource, useRemoveSource } from '@/api/marketing';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton, Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { absoluteTime, relativeTime, useNow } from '@/lib/time';
import { cn } from '@/lib/utils';
import { SOURCE_ICONS } from './categories';
import { MetricDialog, MetricTile } from './MetricChart';
import { KindGrid, SourceDialog, type SourceDialogTarget } from './SourceDialog';

function LogValueButton({ source }: { source: MarketingSourceView }) {
  const log = useLogValue();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const value = Number(text.replace(/[\s,]/g, ''));
  const valid = text.trim() !== '' && Number.isFinite(value);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    log.mutate(
      { source, value },
      {
        onSuccess: () => {
          setOpen(false);
          setText('');
        },
        onError: (err) => toast.error('Could not log the value', { description: errorMessage(err) }),
      },
    );
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="xs">
          <Plus />
          Log value
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60">
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label htmlFor={`log-${source.id}`} className="text-xs font-medium text-muted-foreground">
            {source.name} today
          </label>
          <div className="flex gap-1.5">
            <Input id={`log-${source.id}`} inputMode="decimal" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="1250" />
            <Button type="submit" size="sm" className="h-8" disabled={!valid || log.isPending}>
              {log.isPending ? <Spinner className="size-3.5" /> : 'Save'}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function SourceCard({
  source,
  onEdit,
  onOpenMetric,
}: {
  source: MarketingSourceView;
  onEdit: () => void;
  onOpenMetric: (key: string) => void;
}) {
  const now = useNow();
  const refresh = useRefreshSource();
  const remove = useRemoveSource();
  const confirm = useConfirm();
  const info = SOURCE_KIND_INFO[source.kind];
  const Icon = SOURCE_ICONS[source.kind];
  const refreshing = refresh.isPending && refresh.variables?.id === source.id;

  const askRemove = async () => {
    const ok = await confirm({
      title: `Remove ${source.name}?`,
      description: 'Its history is deleted too. You can connect it again later, but the history starts over.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (ok) remove.mutate(source);
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3.5" aria-label={`${info.label}: ${source.name}`}>
      <header className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 truncate text-[13.5px] font-medium">{source.name}</h3>
        <Badge variant="outline" size="sm" className="shrink-0">
          {info.label}
        </Badge>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {source.lastFetchedAt && (
            <span className="hidden text-xs text-muted-foreground sm:inline" title={absoluteTime(source.lastFetchedAt)}>
              {info.fetched ? 'Read' : 'Logged'} {relativeTime(source.lastFetchedAt, now)}
            </span>
          )}
          {info.fetched ? (
            <Tip content="Read it now">
              <Button variant="ghost" size="icon-xs" onClick={() => refresh.mutate(source)} disabled={refreshing} aria-label={`Refresh ${source.name}`}>
                <RefreshCw className={cn(refreshing && 'animate-spin')} />
              </Button>
            </Tip>
          ) : (
            <LogValueButton source={source} />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={`More for ${source.name}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void askRemove()}>
                <Trash2 />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {source.status === 'error' && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/35 bg-destructive/8 px-2.5 py-2 text-[12.5px]">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">
            <span className="font-medium text-destructive">Could not read it.</span> <span className="text-muted-foreground">{source.error}</span>
            {source.metrics.length > 0 && <span className="text-muted-foreground"> These are the last numbers that worked.</span>}
          </span>
          <Button variant="link" size="xs" className="h-auto px-0" onClick={onEdit}>
            Edit
          </Button>
        </div>
      )}

      {source.metrics.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {source.metrics.map((m) => (
            <MetricTile key={m.key} metric={m} onOpen={() => onOpenMetric(m.key)} />
          ))}
        </div>
      ) : (
        source.status !== 'error' && (
          <p className="text-[12.5px] text-muted-foreground">
            {info.fetched ? (source.status === 'new' ? 'Not read yet.' : `${info.label} had no numbers for it yet.`) : 'Log the first value to start its history.'}
          </p>
        )
      )}
    </section>
  );
}

function Suggestions({ boardId, suggestions }: { boardId: string; suggestions: SourceSuggestion[] }) {
  const add = useAddSource(boardId);
  if (suggestions.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5">
      <span className="text-xs text-muted-foreground">Found in the project:</span>
      {suggestions.map((s) => {
        const Icon = SOURCE_ICONS[s.kind];
        const busy = add.isPending && add.variables?.kind === s.kind && JSON.stringify(add.variables.config) === JSON.stringify(s.config);
        return (
          <Tip key={`${s.kind}:${s.name}`} content={`${SOURCE_KIND_INFO[s.kind].blurb} Found in ${s.reason}.`}>
            <Button
              variant="secondary"
              size="xs"
              disabled={add.isPending}
              onClick={() =>
                add.mutate(
                  { kind: s.kind, config: s.config },
                  {
                    onSuccess: (src) => toast.success(`Connected ${SOURCE_KIND_INFO[s.kind].label}`, { description: src.name }),
                    onError: (err) => toast.error(`Could not connect ${s.name}`, { description: errorMessage(err) }),
                  },
                )
              }
            >
              {busy ? <Spinner className="size-3" /> : <Icon />}
              {s.name}
              <Plus className="opacity-60" />
            </Button>
          </Tip>
        );
      })}
    </div>
  );
}

export function MetricsPanel({ board }: { board: BoardView }) {
  const q = useMarketing(board.id);
  const refreshAll = useRefreshAll(board.id);
  const [dialog, setDialog] = useState<SourceDialogTarget | null>(null);
  const [detail, setDetail] = useState<{ sourceId: string; key: string } | null>(null);

  const sources = q.data?.sources ?? [];
  const fetched = sources.filter((s) => SOURCE_KIND_INFO[s.kind].fetched);
  const detailSource = detail ? sources.find((s) => s.id === detail.sourceId) : undefined;
  const detailMetric = detailSource?.metrics.find((m) => m.key === detail?.key) ?? null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="marketing-metrics">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="marketing-metrics" className="text-[14px] font-semibold tracking-tight">
            Metrics
          </h2>
          <p className="text-xs text-muted-foreground">Read about every six hours. Click a number for its history.</p>
        </div>
        {fetched.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => refreshAll.mutate()} disabled={refreshAll.isPending}>
            <RefreshCw className={cn(refreshAll.isPending && 'animate-spin')} />
            Refresh all
          </Button>
        )}
        {sources.length > 0 && (
          <Button variant="secondary" size="sm" onClick={() => setDialog({})}>
            <Plug />
            Connect source
          </Button>
        )}
      </div>

      {q.isLoading ? (
        <Skeleton className="h-36" />
      ) : q.isError ? (
        <p role="alert" className="text-[13px] text-destructive">
          Could not load the metrics: {errorMessage(q.error)}
        </p>
      ) : (
        <>
          <Suggestions boardId={board.id} suggestions={q.data?.suggestions ?? []} />
          {sources.length === 0 ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
              <div className="flex flex-col gap-1">
                <h3 className="text-[13.5px] font-medium">Connect your numbers</h3>
                <p className="text-[12.5px] text-muted-foreground">
                  Stars, downloads, visitors, sign-ups, mentions: pick where they come from. The Marketing agent sees them too, so its tasks
                  aim at what is weak.
                </p>
              </div>
              <KindGrid onPick={(kind) => setDialog({ kind })} className="lg:grid-cols-3" />
            </div>
          ) : (
            sources.map((s) => (
              <SourceCard key={s.id} source={s} onEdit={() => setDialog({ source: s })} onOpenMetric={(key) => setDetail({ sourceId: s.id, key })} />
            ))
          )}
        </>
      )}

      <SourceDialog boardId={board.id} target={dialog} onClose={() => setDialog(null)} />
      <MetricDialog source={detailSource?.name ?? ''} metric={detailMetric} onClose={() => setDetail(null)} />
    </section>
  );
}
