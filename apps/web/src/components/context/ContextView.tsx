// Context: files the user adds to give the board's agents context (specs, notes, documents, images),
// and the knowledge graph a read-only agent builds from them. Files on the left (drop them anywhere on
// the view), the graph in the middle, the selected node or the overview on the right. The selected
// node and the file in focus are in the URL (?node=key, ?file=id).
import { KNOWLEDGE_NODE_TYPES, MAX_KNOWLEDGE_FILE_MB, type BoardKnowledgeView, type KnowledgeFileView, type KnowledgeNodeType } from '@t3-orchestra/shared';
import { Copy, FilePlus2, Files, MoreHorizontal, Network, NotebookPen, RefreshCw, Search, TriangleAlert, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { isBuildOpen, useDescribeContextFile, useKnowledge, useRemoveContextFile, useStartKnowledgeBuild, useUploadFiles } from '@/api/knowledge';
import { useBoardContext } from '@/components/board/BoardContext';
import { OpenInT3 } from '@/components/ideas/IdeasView';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogTitle, SheetContent } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton, Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { AddFilesDialog, DescribeDialog, NoteDialog, PreviewDialog } from './ContextDialogs';
import { FileList } from './FileList';
import { GraphCanvas } from './GraphCanvas';
import { KnowledgeOverview } from './KnowledgeOverview';
import { matchesSearch, typeColor, typeLabel } from './model';
import { NodePanel } from './NodePanel';

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

function DropZone({ onPick, compact }: { onPick: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong text-center text-muted-foreground transition-colors hover:border-primary/60 hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
        compact ? 'px-3 py-3' : 'px-6 py-8',
      )}
    >
      <Upload className={compact ? 'size-4' : 'size-5'} />
      <span className={compact ? 'text-xs' : 'text-[13px]'}>
        <span className="font-medium text-foreground">Drop files</span> or click to upload
      </span>
      {!compact && <span className="text-xs">PDFs, Markdown, text, Word and Excel files, images, up to {MAX_KNOWLEDGE_FILE_MB} MB each</span>}
    </button>
  );
}

function Empty({ onPick, onNote }: { onPick: () => void; onNote: () => void }) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <span className="grid size-11 place-items-center rounded-full bg-primary/12 text-primary">
          <Network className="size-5" />
        </span>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-base font-semibold">Give the agents context</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Add specs, briefs, meeting notes, designs or any document about the project. An agent reads them into a knowledge graph of its
            requirements, decisions, constraints and terms, and every agent on this board (the planner, coding agents, reviewers, Insights) gets
            the parts that matter for its work.
          </p>
        </div>
        <div className="w-full">
          <DropZone onPick={onPick} />
        </div>
        <Button variant="ghost" size="sm" onClick={onNote}>
          <NotebookPen />
          Or write a note
        </Button>
      </div>
    </div>
  );
}

/** Whether the context folder goes along with the project, as git sees it. */
function gitNote(data: BoardKnowledgeView): string {
  const git = data.git;
  if (!git) return '';
  if (git.ignored) return "It's in .gitignore, so it stays on this computer.";
  if (git.changes > 0) {
    return `${git.changes === 1 ? '1 file is' : `${git.changes} files are`} not committed yet: commit the folder to take the context to another computer.`;
  }
  return data.files.length ? 'Committed, so it goes wherever the project goes.' : 'Commit it to take the context to another computer.';
}

function Banner({ tone, children }: { tone: 'info' | 'warning' | 'danger'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-[12.5px]',
        tone === 'info' && 'border-border bg-primary/6',
        tone === 'warning' && 'border-warning/30 bg-warning/10',
        tone === 'danger' && 'border-destructive/30 bg-destructive/8',
      )}
    >
      {children}
    </div>
  );
}

export function ContextView() {
  const { board } = useBoardContext();
  const q = useKnowledge(board.id);
  const upload = useUploadFiles(board.id);
  const remove = useRemoveContextFile(board.id);
  const describe = useDescribeContextFile(board.id);
  const build = useStartKnowledgeBuild(board.id);
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [hidden, setHidden] = useState<ReadonlySet<KnowledgeNodeType>>(new Set());
  const [focusReq, setFocusReq] = useState<{ key: string; seq: number } | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  /** Files picked or dropped, waiting in the dialog for their descriptions. */
  const [adding, setAdding] = useState<File[]>([]);
  const [describingId, setDescribingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const data = q.data;
  const graph = data?.graph;
  const files = data?.files ?? [];
  const nodeKey = params.get('node');
  const fileId = params.get('file');
  const node = graph?.nodes.find((n) => n.key === nodeKey) ?? null;
  const focusedFile = files.find((f) => f.id === fileId) ?? null;
  const describing = files.find((f) => f.id === describingId) ?? null;

  const setParam = (key: string, value: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  const select = (key: string | null, center = false) => {
    setParam('node', key);
    if (key && center) setFocusReq({ key, seq: Date.now() });
  };

  const matches = useMemo(() => (graph && search.trim() ? graph.nodes.filter((n) => matchesSearch(n, search)) : null), [graph, search]);
  const highlight = useMemo(() => {
    if (matches) return new Set(matches.map((n) => n.key));
    if (focusedFile && graph) return new Set(graph.nodes.filter((n) => n.sources.some((s) => s.fileId === focusedFile.id)).map((n) => n.key));
    return null;
  }, [matches, focusedFile, graph]);
  const typeCounts = useMemo(() => {
    const m = new Map<KnowledgeNodeType, number>();
    for (const n of graph?.nodes ?? []) m.set(n.type, (m.get(n.type) ?? 0) + 1);
    return KNOWLEDGE_NODE_TYPES.filter((t) => m.has(t)).map((t) => ({ type: t, count: m.get(t)! }));
  }, [graph]);

  // A node in the URL when the page opens is brought into view.
  const centered = useRef(false);
  useEffect(() => {
    if (centered.current || !node) return;
    centered.current = true;
    setFocusReq({ key: node.key, seq: Date.now() });
  }, [node]);

  // Escape leaves the selected node (not while typing or in a dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !nodeKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [role="dialog"]')) return;
      select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // They go to the dialog first, for a description each; one dropped while it is open joins the list
  // (a file with the same name takes the earlier one's place).
  const addFiles = (list: FileList | File[] | null) => {
    const arr = Array.from(list ?? []);
    if (!arr.length) return;
    const names = new Set(arr.map((f) => f.name.toLowerCase()));
    setAdding((cur) => [...cur.filter((f) => !names.has(f.name.toLowerCase())), ...arr]);
  };
  const pick = () => picker.current?.click();
  const removeFile = (f: KnowledgeFileView) => {
    if (fileId === f.id) setParam('file', null);
    remove.mutate(f);
  };
  const rebuild = async () => {
    const ok = await confirm({
      title: 'Build the graph again from scratch?',
      description: `An agent reads all ${files.length} file${files.length === 1 ? '' : 's'} again and its result replaces the graph. Use it when the graph has drifted, for example after many changes to the files.`,
      confirmLabel: 'Rebuild',
    });
    if (ok) build.mutate(true);
  };

  const dragProps = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      addFiles(e.dataTransfer.files);
    },
  };

  if (q.isLoading || !data || !graph) {
    return (
      <div className="flex h-full gap-3 p-3">
        <Skeleton className="hidden h-full w-72 md:block" />
        <Skeleton className="h-full flex-1" />
      </div>
    );
  }

  const openBuild = data.builds.find(isBuildOpen);
  const last = data.builds[0];
  const pending = files.filter((f) => f.status === 'pending').length;
  const building = Boolean(openBuild) || build.isPending;

  /** `inSheet`: on phones the files open as a full-width sheet, which needs its own way out. */
  const filesPane = (inSheet: boolean) => (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <h2 className="flex flex-1 items-center gap-2 text-[13px] font-medium">
          <Files className="size-4 text-primary" />
          Files
          <span className="font-mono text-[11px] font-normal text-muted-foreground tabular">{files.length}</span>
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <FilePlus2 />
              Add
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={pick}>
              <Upload />
              Upload files…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setNoteOpen(true)}>
              <NotebookPen />
              Write a note…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {inSheet && (
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => setFilesOpen(false)}>
            <X />
          </Button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1.5 scrollbar-thin">
        <DropZone onPick={pick} compact />
        <FileList
          files={files}
          focused={fileId}
          onFocus={(id) => {
            setParam('file', id);
            setFilesOpen(false);
          }}
          onDescribe={(f) => {
            setDescribingId(f.id);
            setFilesOpen(false);
          }}
          onRemove={removeFile}
        />
      </div>
      <div className="flex shrink-0 items-start gap-2 border-t border-border px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
        <p className="min-w-0 flex-1">
          Kept in the project, with the graph, at <code className="font-mono text-[11px] text-foreground/80">{data.folder}</code>. {gitNote(data)}
        </p>
        <Tip content={data.dir}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Copy the folder path"
            onClick={() =>
              void navigator.clipboard.writeText(data.dir).then(
                () => toast.success('Folder path copied'),
                () => toast.error('Could not copy the path', { description: data.dir }),
              )
            }
          >
            <Copy />
          </Button>
        </Tip>
      </div>
    </>
  );

  return (
    <div className="relative flex h-full min-h-0" {...dragProps}>
      <input
        ref={picker}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = '';
        }}
      />

      <aside className="hidden w-72 shrink-0 flex-col border-r border-border bg-surface/40 md:flex">{filesPane(false)}</aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-3">
          <Button variant="ghost" size="sm" className="-ml-1.5 md:hidden" onClick={() => setFilesOpen(true)}>
            <Files className="text-primary" />
            Files
            <span className="font-mono text-[11px] text-muted-foreground tabular">{files.length}</span>
          </Button>
          <h2 className="hidden min-w-0 items-center gap-2 text-[13px] font-medium md:flex">
            <Network className="size-4 shrink-0 text-primary" />
            <span className="truncate">Knowledge graph</span>
            {graph.nodes.length > 0 && (
              <span className="hidden font-normal whitespace-nowrap text-muted-foreground lg:inline">
                {graph.nodes.length} nodes · {graph.edges.length} links
              </span>
            )}
          </h2>
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            {graph.nodes.length > 0 && (
              <div className="relative min-w-0">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && matches?.[0]) select(matches[0].key, true);
                    if (e.key === 'Escape') setSearch('');
                  }}
                  placeholder="Find a node"
                  aria-label="Find a node"
                  className="h-7 w-32 pr-6 pl-7 text-xs sm:w-44"
                />
                {search && (
                  <button
                    type="button"
                    aria-label="Clear"
                    onClick={() => setSearch('')}
                    className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            )}
            {pending > 0 && !building && (
              <Button size="sm" onClick={() => build.mutate(false)}>
                <Network />
                Read {pending} new file{pending === 1 ? '' : 's'}
              </Button>
            )}
            {building && (
              <Button size="sm" variant="secondary" disabled>
                <Spinner className="size-3.5" />
                Building
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={pick}>
                  <Upload />
                  Upload files…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setNoteOpen(true)}>
                  <NotebookPen />
                  Write a note…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setPreviewOpen(true)}>
                  <Search />
                  What agents see…
                </DropdownMenuItem>
                <DropdownMenuItem disabled={building || files.length === 0} onSelect={() => void rebuild()}>
                  <RefreshCw />
                  Rebuild from scratch…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {openBuild?.status === 'running' && (
          <Banner tone="info">
            <Spinner className="size-3.5 text-primary" />
            <span className="min-w-0 flex-1">
              Build #{openBuild.number} is reading {openBuild.fileNames.length === 1 ? openBuild.fileNames[0] : `${openBuild.fileNames.length} files`} into
              the graph. Agents keep using the graph as it is until it finishes.
            </span>
          </Banner>
        )}
        {openBuild?.status === 'waiting' && (
          <Banner tone="warning">
            <TriangleAlert className="size-4 text-warning" />
            <span className="min-w-0 flex-1">Build #{openBuild.number} is waiting for you in T3.</span>
            <OpenInT3 link={openBuild.threadLink} variant="warning" />
          </Banner>
        )}
        {!openBuild && last?.status === 'failed' && pending > 0 && (
          <Banner tone="danger">
            <TriangleAlert className="size-4 text-destructive" />
            <span className="min-w-0 flex-1">
              Build #{last.number} failed{last.error ? `: ${last.error}` : '.'}
            </span>
            <OpenInT3 link={last.threadLink} />
            <Button size="sm" variant="secondary" onClick={() => build.mutate(false)}>
              Try again
            </Button>
          </Banner>
        )}

        {data.folderProblem && (
          <Banner tone="warning">
            <TriangleAlert className="size-4 text-warning" />
            <span className="min-w-0 flex-1">{data.folderProblem}</span>
          </Banner>
        )}

        {files.length === 0 ? (
          <Empty onPick={pick} onNote={() => setNoteOpen(true)} />
        ) : (
          <>
            {typeCounts.length > 0 && (
              <div role="group" aria-label="Node types (click to hide or show)" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
                {typeCounts.map(({ type, count }) => {
                  const off = hidden.has(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={!off}
                      title={off ? `Show ${typeLabel(type).toLowerCase()} nodes` : `Hide ${typeLabel(type).toLowerCase()} nodes`}
                      onClick={() =>
                        setHidden((h) => {
                          const next = new Set(h);
                          if (off) next.delete(type);
                          else next.add(type);
                          return next;
                        })
                      }
                      className={cn(
                        'flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-[11.5px] transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                        off && 'text-muted-foreground line-through decoration-muted-foreground/60',
                      )}
                    >
                      <span className={cn('size-2 rounded-full', off && 'opacity-30')} style={{ background: typeColor(type) }} />
                      {typeLabel(type)}
                      <span className="font-mono text-[10.5px] text-muted-foreground tabular">{count}</span>
                    </button>
                  );
                })}
                {(matches || focusedFile) && (
                  <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    {matches ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : `${highlight?.size ?? 0} from ${focusedFile!.name}`}
                    {focusedFile && !matches && (
                      <Button variant="ghost" size="icon-xs" aria-label="Show the whole graph" onClick={() => setParam('file', null)}>
                        <X />
                      </Button>
                    )}
                  </span>
                )}
              </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
              {graph.nodes.length > 0 ? (
                <GraphCanvas
                  graph={graph}
                  hiddenTypes={hidden}
                  selected={node?.key ?? null}
                  onSelect={(k) => select(k)}
                  highlight={highlight}
                  focus={focusReq}
                  className="min-h-[300px] flex-1"
                />
              ) : (
                <div className="flex min-h-[260px] flex-1 items-center justify-center p-6 text-center">
                  {building ? (
                    <p className="flex max-w-sm flex-col items-center gap-2 text-[13px] text-muted-foreground">
                      <Spinner className="size-5 text-primary" />
                      An agent is reading the files. The graph appears here when it is done, usually within a few minutes.
                    </p>
                  ) : pending > 0 ? (
                    <div className="flex max-w-sm flex-col items-center gap-3">
                      <p className="text-[13px] text-muted-foreground">
                        {pending} file{pending === 1 ? ' is' : 's are'} waiting to be read into the graph.
                      </p>
                      <Button onClick={() => build.mutate(false)}>
                        <Network />
                        Build the graph
                      </Button>
                    </div>
                  ) : (
                    <p className="max-w-sm text-[13px] text-muted-foreground">The agent found nothing to put in the graph. Add files with more to say, or a note.</p>
                  )}
                </div>
              )}
              <aside
                aria-label={node ? node.name : 'Overview'}
                className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border scrollbar-thin lg:max-h-none lg:w-80 lg:border-t-0 lg:border-l"
              >
                {node ? (
                  <NodePanel node={node} graph={graph} files={files} onSelect={(k) => select(k, true)} onClose={() => select(null)} />
                ) : (
                  <KnowledgeOverview data={data} board={board} onSelect={(k) => select(k, true)} onPreview={() => setPreviewOpen(true)} />
                )}
              </aside>
            </div>
          </>
        )}
      </section>

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85 backdrop-blur-[1px]">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Upload className="size-4 text-primary" />
            Drop to add {board.contextAutoBuild ? 'and read into the graph' : 'to the context'}
          </p>
        </div>
      )}

      <Dialog open={filesOpen} onOpenChange={setFilesOpen}>
        <SheetContent className="md:hidden" aria-describedby={undefined}>
          <DialogTitle className="sr-only">Context files</DialogTitle>
          {filesPane(true)}
        </SheetContent>
      </Dialog>
      <AddFilesDialog
        files={adding}
        existing={files}
        onCancel={() => setAdding([])}
        onAdd={(items) => {
          // The dialog closes at once; the upload toast shows the progress.
          setAdding([]);
          upload.mutate(items.map(({ file, description }) => ({ name: file.name, data: file, description })));
        }}
      />
      <DescribeDialog
        file={describing}
        saving={describe.isPending}
        onOpenChange={(open) => !open && setDescribingId(null)}
        onSave={(description, reread) => describe.mutate({ file: describing!, description, reread }, { onSuccess: () => setDescribingId(null) })}
      />
      <NoteDialog
        open={noteOpen}
        onOpenChange={setNoteOpen}
        saving={upload.isPending}
        onSave={(name, text) => upload.mutate([{ name, data: new Blob([text], { type: 'text/markdown' }) }], { onSuccess: () => setNoteOpen(false) })}
      />
      <PreviewDialog boardId={board.id} open={previewOpen} onOpenChange={setPreviewOpen} />
    </div>
  );
}
