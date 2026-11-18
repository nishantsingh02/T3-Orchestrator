// The Context view's dialogs: adding files with a description of each, describing a file already
// added, writing a note (saved as a Markdown file like any upload), and "What agents see", the
// knowledge section an agent working on some text would get.
import { MAX_KNOWLEDGE_DESCRIPTION, MAX_KNOWLEDGE_FILE_BYTES, MAX_KNOWLEDGE_FILE_MB, knowledgeFileKind, type KnowledgeFileView } from '@t3-orchestra/shared';
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useKnowledgePreview } from '@/api/knowledge';
import { Field } from '@/components/fields';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { FILE_ICONS, fileSize, noteFileName } from './model';

const DESCRIPTION_HINT = 'e.g. The signed-off spec for v2. Sections 3 to 5 are current; the appendix is out of date.';

/** Ctrl/Cmd+Enter in a description sends the form. */
function submitOnCtrlEnter(e: KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }
}

/** Characters left, once the description gets near the limit. */
function LengthLeft({ text }: { text: string }) {
  const left = MAX_KNOWLEDGE_DESCRIPTION - text.length;
  if (left > 150) return null;
  return <span className={cn('font-mono text-[11px] tabular', left < 20 ? 'text-warning' : 'text-muted-foreground')}>{left}</span>;
}

/**
 * Files picked or dropped wait here for a description each (all optional) before they upload. (Files
 * dropped while it is open reach the view's drop handler, which adds them to `files`.)
 */
export function AddFilesDialog({
  files,
  existing,
  onCancel,
  onAdd,
}: {
  files: File[];
  /** The board's files: a file with the same name is replaced, and its description is the starting text. */
  existing: KnowledgeFileView[];
  onCancel: () => void;
  onAdd: (items: Array<{ file: File; description: string }>) => void;
}) {
  const [texts, setTexts] = useState<Record<string, string>>({});
  const known = new Map(existing.map((f) => [f.name.toLowerCase(), f]));
  const keyOf = (f: File) => f.name.toLowerCase();
  const textOf = (f: File) => texts[keyOf(f)] ?? known.get(keyOf(f))?.description ?? '';
  useEffect(() => {
    if (files.length === 0) setTexts({});
  }, [files.length]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onAdd(files.map((file) => ({ file, description: textOf(file).trim() })));
  };
  const one = files.length === 1;

  return (
    <Dialog open={files.length > 0} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="truncate">{one ? `Add ${files[0]!.name}` : `Add ${files.length} files`}</DialogTitle>
            <DialogDescription>
              Say what {one ? 'the file is' : 'each file is'} and what in it matters, so the agent reads it into the graph the right way.
              Optional: the agent reads {one ? 'it' : 'them'} either way.
            </DialogDescription>
          </DialogHeader>
          <ul className={cn('flex flex-col gap-3', !one && '-mx-1 max-h-[55vh] overflow-y-auto px-1 scrollbar-thin')}>
            {files.map((file, i) => {
              const Icon = FILE_ICONS[knowledgeFileKind(file.name)];
              const replaces = known.get(keyOf(file));
              const tooBig = file.size > MAX_KNOWLEDGE_FILE_BYTES;
              const id = `add-file-${i}`;
              const text = textOf(file);
              return (
                <li key={`${keyOf(file)}-${i}`} className="flex flex-col gap-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <Label htmlFor={id} className="min-w-0 truncate text-[13px] text-foreground">
                      {file.name}
                    </Label>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular">{fileSize(file.size)}</span>
                    <span className="ml-auto shrink-0">
                      <LengthLeft text={text} />
                    </span>
                  </div>
                  {tooBig ? (
                    <p className="text-xs text-destructive">Over {MAX_KNOWLEDGE_FILE_MB} MB: it won't be added.</p>
                  ) : (
                    <>
                      <Textarea
                        id={id}
                        autoFocus={i === 0}
                        rows={one ? 4 : 2}
                        maxLength={MAX_KNOWLEDGE_DESCRIPTION}
                        value={text}
                        onChange={(e) => setTexts((t) => ({ ...t, [keyOf(file)]: e.target.value }))}
                        onKeyDown={submitOnCtrlEnter}
                        placeholder={i === 0 ? DESCRIPTION_HINT : 'What it is and what in it matters'}
                        className="text-[13px]"
                      />
                      {replaces && <p className="text-xs text-muted-foreground">Replaces the {replaces.name} already on the board.</p>}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <DialogFooter className="items-center">
            <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">Ctrl+Enter adds {one ? 'it' : 'them'}</span>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">{one ? 'Add file' : `Add ${files.length} files`}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Edits what the user says a file is; a file already read can be read again with it. */
export function DescribeDialog({
  file,
  onOpenChange,
  onSave,
  saving,
}: {
  file: KnowledgeFileView | null;
  onOpenChange: (open: boolean) => void;
  onSave: (description: string, reread: boolean) => void;
  saving: boolean;
}) {
  const [text, setText] = useState('');
  const [reread, setReread] = useState(true);
  const id = file?.id;
  // Another file starts from its own description; live updates to the same file don't undo typing.
  useEffect(() => {
    if (!file) return;
    setText(file.description ?? '');
    setReread(true);
  }, [id]);
  if (!file) return null;

  const read = file.status !== 'pending' && !file.reading;
  const changed = text.trim() !== (file.description ?? '');
  // A file that couldn't be read is worth another try with the same description.
  const canSave = changed || (read && reread && file.status === 'skipped');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSave && !saving) onSave(text.trim(), read && reread);
  };
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="truncate">Describe {file.name}</DialogTitle>
            <DialogDescription>
              What the file is and what in it matters. The agent that builds the graph reads the file with it in mind, and every agent sees it
              next to the file.
            </DialogDescription>
          </DialogHeader>
          {(file.status === 'skipped' ? file.note : file.summary) && (
            <div className="rounded-md border border-border bg-surface/50 px-3 py-2 text-[12.5px] leading-relaxed">
              <span className="block text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {file.status === 'skipped' ? "Why the agent couldn't read it" : 'What the agent made of it'}
              </span>
              {file.status === 'skipped' ? file.note : file.summary}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="file-description">Description</Label>
              <LengthLeft text={text} />
            </div>
            <Textarea
              id="file-description"
              autoFocus
              rows={5}
              maxLength={MAX_KNOWLEDGE_DESCRIPTION}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={submitOnCtrlEnter}
              placeholder={DESCRIPTION_HINT}
              className="text-[13px]"
            />
          </div>
          {read ? (
            <label className="flex cursor-pointer items-start gap-2.5">
              <Checkbox checked={reread} onCheckedChange={(c) => setReread(c === true)} className="mt-0.5" />
              <span className="text-[13px]">
                {file.status === 'skipped' ? 'Try reading it again with this description' : 'Read it into the graph again with this description'}
                <span className="block text-xs text-muted-foreground">
                  {reread
                    ? 'What it said in the graph is replaced by the new reading.'
                    : 'The graph stays as it is; agents still see the new description next to the file.'}
                </span>
              </span>
            </label>
          ) : (
            <p className="text-xs text-muted-foreground">
              {file.reading
                ? 'A build is reading it right now. A changed description has it read again after that.'
                : "It isn't in the graph yet: the agent reads it with this description."}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave || saving}>
              {saving && <Spinner className="size-3.5" />}
              {read && reread && (changed || file.status === 'skipped') ? 'Save and read again' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function NoteDialog({
  open,
  onOpenChange,
  onSave,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, text: string) => void;
  saving: boolean;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) {
      setTitle('');
      setText('');
    }
  }, [open]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || saving) return;
    onSave(noteFileName(title || text.split('\n')[0]!.replace(/^#+\s*/, '')), title.trim() ? `# ${title.trim()}\n\n${text.trim()}\n` : `${text.trim()}\n`);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Write a note</DialogTitle>
            <DialogDescription>
              Decisions, rules, who the users are, what to avoid: anything agents should know that isn't written down elsewhere. It is saved as a
              Markdown file and read into the graph like an upload.
            </DialogDescription>
          </DialogHeader>
          <Field label="Title" htmlFor="note-title">
            <Input id="note-title" autoFocus value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} placeholder="Refund rules" />
          </Field>
          <Field label="Note" htmlFor="note-text">
            <Textarea
              id="note-text"
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'Only admins can refund, within 30 days of the order.\nWe use Stripe Checkout; no card data touches our servers.'}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!text.trim() || saving}>
              {saving && <Spinner className="size-3.5" />}
              Save note
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PreviewDialog({ boardId, open, onOpenChange }: { boardId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(draft.trim()), 350);
    return () => clearTimeout(t);
  }, [draft]);
  const preview = useKnowledgePreview(boardId, q, open);
  const text = preview.data?.text ?? '';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>What agents see</DialogTitle>
          <DialogDescription>
            The section added to an agent's prompt. Type a task or a question to see which nodes it would get; with nothing that matches, agents get
            the best-connected ones.
          </DialogDescription>
        </DialogHeader>
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. Let support staff refund an order" aria-label="A task or question" />
        <div className="max-h-[55vh] min-h-40 overflow-y-auto rounded-md border border-border bg-surface/50 p-3 scrollbar-thin">
          {preview.isLoading ? (
            <Spinner className="size-4" />
          ) : text ? (
            <Markdown className="text-[12.5px]">{text}</Markdown>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">Nothing yet: add files first.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
