// The side panel with nothing selected: what agents are told (the overview the build wrote), the
// board's settings for it, every node by type (the graph as a list), and the recent builds.
import { KNOWLEDGE_NODE_TYPES, type BoardKnowledgeView, type BoardView, type KnowledgeBuildView, type KnowledgeNodeType } from '@t3-orchestra/shared';
import { ChevronRight, Eye } from 'lucide-react';
import { useMemo } from 'react';
import { usePatchBoard } from '@/api/boards';
import { SwitchRow } from '@/components/fields';
import { OpenInT3 } from '@/components/ideas/IdeasView';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { TypeDot } from './NodePanel';
import { typeLabel } from './model';

function BuildLine({ b }: { b: KnowledgeBuildView }) {
  const s = b.stats;
  const files = b.fileNames.length === 1 ? b.fileNames[0] : `${b.fileNames.length} files`;
  return (
    <li className="flex flex-col gap-0.5 py-2 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="font-medium">#{b.number}</span>
        {b.fresh && <span className="text-muted-foreground">rebuild</span>}
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={b.fileNames.join(', ')}>
          {files}
        </span>
        {b.status === 'running' && <Spinner className="size-3" />}
        {b.status === 'waiting' && <span className="text-warning">waiting in T3</span>}
        {b.status === 'failed' && <span className="text-destructive">failed</span>}
        {b.status === 'done' && <span className="text-muted-foreground">{relativeTime(b.finishedAt)}</span>}
      </span>
      {b.status === 'done' && s && (
        <span className="text-muted-foreground">
          {s.added} added · {s.updated} updated{s.removed ? ` · ${s.removed} removed` : ''}
        </span>
      )}
      {b.status === 'failed' && b.error && <span className="line-clamp-3 text-destructive/90">{b.error}</span>}
      {(b.status === 'failed' || b.status === 'waiting') && (
        <span className="-ml-2">
          <OpenInT3 link={b.threadLink} variant={b.status === 'waiting' ? 'warning' : 'ghost'} />
        </span>
      )}
    </li>
  );
}

export function KnowledgeOverview({
  data,
  board,
  onSelect,
  onPreview,
}: {
  data: BoardKnowledgeView;
  board: BoardView;
  onSelect: (key: string) => void;
  onPreview: () => void;
}) {
  const patch = usePatchBoard();
  const byType = useMemo(() => {
    const m = new Map<KnowledgeNodeType, typeof data.graph.nodes>();
    for (const n of [...data.graph.nodes].sort((a, b) => a.name.localeCompare(b.name))) m.set(n.type, [...(m.get(n.type) ?? []), n]);
    return KNOWLEDGE_NODE_TYPES.filter((t) => m.has(t)).map((t) => ({ type: t, nodes: m.get(t)! }));
  }, [data.graph.nodes]);

  return (
    <div className="flex flex-col gap-5 p-3">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold">What agents are told</h3>
          <Button variant="ghost" size="xs" onClick={onPreview}>
            <Eye />
            What agents see
          </Button>
        </div>
        {data.graph.digest.trim() ? (
          <Markdown className="text-[12.5px]">{data.graph.digest}</Markdown>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">
            The first build writes an overview of all the files here. Every agent on the board (the planner, coding agents, reviewers, Insights)
            reads it, with the nodes that match its work.
          </p>
        )}
      </section>

      <section className="-my-2.5 border-y border-border">
        <SwitchRow
          label="Use in agent prompts"
          hint="Agents get the overview, the nodes that match their task and where the files are."
          checked={board.contextInPrompts}
          onCheckedChange={(v) => patch.mutate({ board, patch: { contextInPrompts: v } })}
        />
        <SwitchRow
          label="Read new files right away"
          hint="A build starts after each upload. Off: press Build when you are ready."
          checked={board.contextAutoBuild}
          onCheckedChange={(v) => patch.mutate({ board, patch: { contextAutoBuild: v } })}
        />
      </section>

      {byType.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[13px] font-semibold">In the graph</h3>
          <ul className="flex flex-col">
            {byType.map(({ type, nodes }) => (
              <li key={type}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
                    <TypeDot node={{ type }} className="size-2.5 rounded-full" />
                    <span className="flex-1">{typeLabel(type)}</span>
                    <span className="font-mono text-[11px] text-muted-foreground tabular">{nodes.length}</span>
                  </summary>
                  <ul className="mb-1 ml-6 flex flex-col">
                    {nodes.map((n) => (
                      <li key={n.key}>
                        <button
                          type="button"
                          onClick={() => onSelect(n.key)}
                          className="w-full truncate rounded-md px-1.5 py-0.5 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                          title={n.summary}
                        >
                          {n.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.builds.length > 0 && (
        <section className="flex flex-col">
          <h3 className="text-[13px] font-semibold">Builds</h3>
          <ul className={cn('flex flex-col divide-y divide-border')}>
            {data.builds.slice(0, 6).map((b) => (
              <BuildLine key={b.id} b={b} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
