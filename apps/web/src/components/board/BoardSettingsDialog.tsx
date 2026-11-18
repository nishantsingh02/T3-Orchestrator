import type { BoardSettings, BoardView, PatchBoardBody } from '@t3-orchestra/shared';
import { Archive, BookOpenText, Download, History, ShieldExclamationPoint } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useArchiveBoard, useBoardProjectCheck, useImportFromT3, usePatchBoard } from '@/api/boards';
import { api } from '@/api/client';
import { BoardSettingsFields, boardSettingsOf } from '@/components/BoardSettingsFields';
import { Field } from '@/components/fields';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { isImportOpen } from '@/components/import/ProjectImport';
import { relativeTime } from '@/lib/time';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board: BoardView;
  /** Opens the Project context dialog (what the last import wrote). */
  onViewContext: () => void;
}

export function BoardSettingsDialog({ open, onOpenChange, board, onViewContext }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {open && <BoardSettingsForm board={board} onDone={() => onOpenChange(false)} onViewContext={onViewContext} />}
      </DialogContent>
    </Dialog>
  );
}

/** Under the brief: where the project context came from, and a way to (re)import it from T3. */
function ImportRow({ board, onView }: { board: BoardView; onView: () => void }) {
  const start = useImportFromT3();
  const imp = board.projectImport;
  const running = isImportOpen(imp);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs">
      {running ? <Spinner className="size-3.5" /> : <History className="size-3.5 text-muted-foreground" />}
      <span className="min-w-0 flex-1 text-muted-foreground">
        {running
          ? 'Learning about the project from its T3 threads…'
          : imp?.status === 'done'
            ? `Project context imported from ${imp.threadCount} T3 thread${imp.threadCount === 1 ? '' : 's'}, ${relativeTime(imp.finishedAt)}.`
            : imp?.status === 'failed'
              ? `The last import failed: ${imp.error}`
              : "Have an agent read the project's T3 threads and the code, and write what the project is and where it stands here."}
      </span>
      {imp?.status === 'done' && (
        <Button variant="ghost" size="xs" onClick={onView}>
          <BookOpenText />
          View
        </Button>
      )}
      <Button variant="secondary" size="xs" onClick={() => start.mutate(board)} disabled={running || start.isPending}>
        {imp ? 'Import again' : 'Import from T3'}
      </Button>
    </div>
  );
}

/** Warning shown when T3 runs this board's threads with full access (spec §16). */
export function RuntimeModeWarning({ mode }: { mode: string | null }) {
  if (mode !== 'full-access') return null;
  return (
    <div className="flex gap-2.5 rounded-md border border-warning/35 bg-warning/10 p-3 text-xs">
      <ShieldExclamationPoint className="mt-0.5 size-4 shrink-0 text-warning" />
      <div>
        <p className="font-medium text-warning">Agents run with full access</p>
        <p className="mt-0.5 text-muted-foreground">
          T3 started this board's last thread in <code className="font-mono">full-access</code> runtime mode (the
          project's default). Agents can run commands and edit files without asking. Change the project's runtime mode in
          T3 if that's not what you want.
        </p>
      </div>
    </div>
  );
}

function BoardSettingsForm({ board, onDone, onViewContext }: { board: BoardView; onDone: () => void; onViewContext: () => void }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const patch = usePatchBoard();
  const archive = useArchiveBoard();
  const check = useBoardProjectCheck(board.id, true);

  const [name, setName] = useState(board.name);
  const [baseBranch, setBaseBranch] = useState(board.baseBranch);
  const [brief, setBrief] = useState(board.brief);
  // The brief as it was when the form opened (or last updated by the server while untouched), so an
  // import finishing meanwhile isn't undone by Save.
  const [briefBase, setBriefBase] = useState(board.brief);
  useEffect(() => {
    if (brief === briefBase && board.brief !== briefBase) {
      setBrief(board.brief);
      setBriefBase(board.brief);
    }
  }, [board.brief]);
  const [settings, setSettings] = useState<BoardSettings>(() => boardSettingsOf(board));

  const branches = useMemo(() => {
    const list = check.data?.branches ?? [];
    return list.includes(board.baseBranch) ? list : [board.baseBranch, ...list];
  }, [check.data, board.baseBranch]);

  const changes = useMemo(() => {
    const out: PatchBoardBody = {};
    if (name.trim() && name.trim() !== board.name) out.name = name.trim();
    if (baseBranch !== board.baseBranch) out.baseBranch = baseBranch;
    if (brief !== briefBase) out.brief = brief;
    const current = boardSettingsOf(board);
    for (const k of Object.keys(settings) as Array<keyof BoardSettings>) {
      if (settings[k] !== current[k]) (out as Record<string, unknown>)[k] = settings[k];
    }
    return out;
  }, [name, baseBranch, brief, briefBase, settings, board]);
  const dirty = Object.keys(changes).length > 0;

  const save = () => {
    if (!dirty) return onDone();
    patch.mutate(
      { board, patch: changes },
      {
        onSuccess: (b) => {
          toast.success('Board settings saved');
          onDone();
          if (b.slug !== board.slug) navigate(`/b/${b.slug}`, { replace: true });
        },
      },
    );
  };

  const doArchive = async () => {
    const ok = await confirm({
      title: `Archive ${board.name}?`,
      description: 'The board disappears from the list. Tasks, branches and T3 threads are not touched.',
      confirmLabel: 'Archive board',
      variant: 'destructive',
    });
    if (!ok) return;
    archive.mutate(board, {
      onSuccess: () => {
        onDone();
        navigate('/');
      },
    });
  };

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Board settings</DialogTitle>
        <DialogDescription className="font-mono text-xs">{board.projectPath}</DialogDescription>
      </DialogHeader>

      <RuntimeModeWarning mode={board.observedRuntimeMode} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="bs-name">
          <Input id="bs-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Base branch"
          hint={check.isLoading ? 'Loading branches…' : check.isError ? 'Could not list branches.' : undefined}
        >
          <Select
            value={baseBranch}
            onValueChange={setBaseBranch}
            options={branches.map((b) => ({ value: b, label: <span className="font-mono text-xs">{b}</span> }))}
          />
        </Field>
      </div>

      <Field label="Board brief" hint="Markdown. Included in every implementation prompt as shared context." htmlFor="bs-brief">
        <Textarea
          id="bs-brief"
          rows={6}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          className="font-mono text-[12px]"
          placeholder="Project conventions, architecture notes, plan summaries…"
        />
        <ImportRow board={board} onView={onViewContext} />
      </Field>

      <div className="rounded-md border border-border px-3">
        <BoardSettingsFields mode="change" value={settings} onChange={(p) => setSettings((s) => ({ ...s, ...p }))} />
      </div>

      <DialogFooter className="items-center">
        <div className="mr-auto flex gap-1">
          <Button variant="ghost" size="sm" asChild>
            <a href={api.boardExportUrl(board.id)} download={`${board.slug}.json`}>
              <Download />
              Export JSON
            </a>
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={doArchive} disabled={archive.isPending}>
            <Archive />
            Archive
          </Button>
        </div>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={save} disabled={patch.isPending || !name.trim()}>
          {patch.isPending && <Spinner className="size-3.5 text-primary-foreground" />}
          {dirty ? 'Save changes' : 'Done'}
        </Button>
      </DialogFooter>
    </div>
  );
}
