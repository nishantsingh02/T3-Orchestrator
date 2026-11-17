// One node of the knowledge graph: what it says, where it comes from (file, page, quote), where it
// lives in the code, and its links, each a way to the node at the other end.
import type { KnowledgeFileView, KnowledgeGraph, KnowledgeNode } from '@t3-orchestra/shared';
import { ArrowLeft, Code2, FileText, X } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { relativeTime } from '@/lib/time';
import { linksOf, typeColor, typeLabel } from './model';

export function TypeDot({ node, className }: { node: Pick<KnowledgeNode, 'type'>; className?: string }) {
  return <span aria-hidden className={className ?? 'size-2.5 shrink-0 rounded-full'} style={{ background: typeColor(node.type) }} />;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h4>
      {children}
    </section>
  );
}

export function NodePanel({
  node,
  graph,
  files,
  onSelect,
  onClose,
}: {
  node: KnowledgeNode;
  graph: KnowledgeGraph;
  files: KnowledgeFileView[];
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  const byKey = useMemo(() => new Map(graph.nodes.map((n) => [n.key, n])), [graph]);
  const links = useMemo(() => linksOf(graph, node.key, byKey), [graph, node.key, byKey]);
  const fileOf = (id: string) => files.find((f) => f.id === id);

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex items-start gap-2">
        <Button variant="ghost" size="icon-xs" className="-ml-1 shrink-0" aria-label="Back to the overview" onClick={onClose}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <TypeDot node={node} className="size-2 rounded-full" />
            {typeLabel(node.type)}
          </p>
          <h3 className="mt-0.5 text-[15px] leading-snug font-semibold text-balance">{node.name}</h3>
          {node.aliases.length > 0 && <p className="mt-0.5 text-xs text-muted-foreground">Also called {node.aliases.join(', ')}</p>}
        </div>
        <Button variant="ghost" size="icon-xs" className="hidden shrink-0 lg:inline-flex" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>

      <p className="text-[13px] leading-relaxed whitespace-pre-line">{node.summary}</p>

      {node.sources.length > 0 && (
        <Section title="From">
          <ul className="flex flex-col gap-2">
            {node.sources.map((s, i) => {
              const f = fileOf(s.fileId);
              return (
                <li key={`${s.fileId}:${i}`} className="text-xs leading-relaxed">
                  <span className="flex items-center gap-1.5">
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    {f ? (
                      <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 truncate font-medium hover:underline">
                        {f.name}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">A removed file</span>
                    )}
                    {s.where && <span className="min-w-0 truncate text-muted-foreground">· {s.where}</span>}
                  </span>
                  {s.quote && <blockquote className="mt-1 border-l-2 border-border pl-2 text-muted-foreground italic">{s.quote}</blockquote>}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {node.code.length > 0 && (
        <Section title="In the code">
          <ul className="flex flex-col gap-1">
            {node.code.map((c) => (
              <li key={c} className="flex items-center gap-1.5 text-xs">
                <Code2 className="size-3.5 shrink-0 text-muted-foreground" />
                <code className="min-w-0 truncate font-mono select-all" title={c}>
                  {c}
                </code>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Links (${links.length})`}>
        {links.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing links to it yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {links.map((l) => (
              <li key={`${l.edge.from}|${l.edge.relation}|${l.edge.to}`}>
                <button
                  type="button"
                  onClick={() => onSelect(l.other.key)}
                  className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  {l.outgoing ? (
                    <>
                      <span className="shrink-0 text-muted-foreground">{l.edge.relation}</span>
                      <TypeDot node={l.other} className="size-2 shrink-0 rounded-full" />
                      <span className="min-w-0 truncate font-medium">{l.other.name}</span>
                    </>
                  ) : (
                    <>
                      <TypeDot node={l.other} className="size-2 shrink-0 rounded-full" />
                      <span className="min-w-0 truncate font-medium">{l.other.name}</span>
                      <span className="shrink-0 text-muted-foreground">{l.edge.relation} this</span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <p className="text-[11px] text-muted-foreground">Updated {relativeTime(node.updatedAt)}</p>
    </div>
  );
}
