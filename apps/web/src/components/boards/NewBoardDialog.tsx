import {
  DEFAULT_BOARD_SETTINGS,
  folderNameProblem,
  GITHUB_REPO_NAME_RE,
  githubRepoName,
  type BoardSettings,
  type GithubAccountView,
  type NewFolderCheck,
  type ProjectSetupResult,
  type T3ProjectView,
} from '@t3-orchestra/shared';
import { Check, ChevronDown, ChevronRight, CircleX, FolderGit2, FolderOpen, FolderPlus, GitBranchPlus, History, Lock, Plus, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  useAddToT3,
  useCheckNewFolder,
  useCreateBoard,
  useGithubAccount,
  usePickFolder,
  useRecheckGithub,
  useSetupProject,
  useT3Projects,
  useValidateProject,
} from '@/api/boards';
import { errorMessage, isApiError } from '@/api/client';
import { useSettings } from '@/api/settings';
import type { ProjectValidation } from '@/api/types';
import { BoardSettingsFields } from '@/components/BoardSettingsFields';
import { Field } from '@/components/fields';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton, Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { readString, writeString } from '@/lib/storage';
import { relativeTime } from '@/lib/time';
import { basename, cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewBoardDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">{open && <NewBoardForm onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function CheckRow({ ok, pending, icon, children, action }: { ok: boolean; pending?: boolean; icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex min-h-7 items-center gap-2 text-[13px]">
      {pending ? (
        <Spinner className="size-3.5" />
      ) : (
        (icon ?? (ok ? <Check className="size-3.5 shrink-0 text-success" /> : <CircleX className="size-3.5 shrink-0 text-destructive" />))
      )}
      <span className={cn('min-w-0 flex-1', !ok && !pending && 'text-foreground')}>{children}</span>
      {action}
    </li>
  );
}

function settingsSummary(s: BoardSettings): string {
  return [
    s.autoRun ? 'Auto-run on' : 'Auto-run off',
    `${s.maxParallel} parallel`,
    s.aiReview ? `AI review on (${s.maxFixRounds} fix rounds)` : 'AI review off',
    { local: 'Local merge', pr: 'PR', manual: 'Manual merge' }[s.mergeStrategy],
  ].join(' · ');
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The parent folder last used for a new project folder. */
const LAST_PARENT_KEY = 'new-board:parent';

/** Roughly what git takes as a branch name; the server asks git itself. */
const branchNameOk = (b: string) => /^[^\s~^:?*[\\]+$/.test(b) && !b.startsWith('-') && !b.endsWith('/') && !b.endsWith('.lock') && !b.includes('..');

function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') || /^[A-Za-z]:/.test(parent) ? '\\' : '/';
  return parent.replace(/[\\/]+$/, '') + sep + name;
}

/** "From T3 Code": the projects T3 knows, most recently active first, to pick from instead of typing a path. */
function T3ProjectPicker({ selected, onPick }: { selected: string | null; onPick: (p: T3ProjectView) => void }) {
  const projects = useT3Projects();
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = projects.data ?? [];
    return needle ? list.filter((p) => p.title.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle)) : list;
  }, [projects.data, q]);

  if (projects.isError) {
    return (
      <p className="rounded-md border border-border bg-surface px-3 py-2.5 text-[13px] text-muted-foreground">
        Couldn't list T3's projects: {errorMessage(projects.error)}. Choose an existing folder instead.
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search T3 projects"
          className="pl-8"
          aria-label="Search T3 projects"
        />
      </div>
      <ul className="max-h-60 overflow-y-auto rounded-md border border-border scrollbar-thin" aria-label="T3 Code projects">
        {projects.isLoading &&
          Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="border-b border-border px-3 py-2 last:border-b-0">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-1.5 h-3 w-64" />
            </li>
          ))}
        {!projects.isLoading && shown.length === 0 && (
          <li className="px-3 py-4 text-center text-[13px] text-muted-foreground">
            {q.trim() ? 'No project matches.' : 'T3 Code has no projects yet.'}
          </li>
        )}
        {shown.map((p) => {
          const active = selected === p.path;
          return (
            <li key={p.path} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => onPick(p)}
                aria-pressed={active}
                className={cn(
                  'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none',
                  active && 'bg-primary/8 hover:bg-primary/10',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 grid size-4 shrink-0 place-content-center rounded-full border',
                    active ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong',
                  )}
                >
                  {active && <Check className="size-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] font-medium">{p.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular">
                      {plural(p.threadCount, 'thread')}
                      {p.lastActivityAt && <> · {relativeTime(p.lastActivityAt)}</>}
                    </span>
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">{p.path}</span>
                  {p.boardSlug && <span className="mt-0.5 block text-xs text-muted-foreground">Already has a board</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Browse…: the OS's own folder window, opened by the server on the computer it runs on. */
function BrowseButton({ title, startIn, onPicked }: { title: string; startIn: string; onPicked: (path: string) => void }) {
  const pick = usePickFolder();
  return (
    <Button
      variant="secondary"
      className="shrink-0"
      disabled={pick.isPending}
      title={pick.isPending ? 'Choose a folder in the window that opened' : undefined}
      onClick={() =>
        pick.mutate(
          { title, startIn: startIn.trim() || undefined },
          {
            onSuccess: (r) => r.path && onPicked(r.path),
            onError: (err) => toast.error("Couldn't open the folder window", { description: errorMessage(err) }),
          },
        )
      }
    >
      {pick.isPending ? <Spinner className="size-3.5" /> : <FolderOpen />}
      Browse…
    </Button>
  );
}

function PathInput({ icon, ...props }: { icon: ReactNode } & ComponentProps<typeof Input>) {
  return (
    <div className="relative min-w-0 flex-1">
      <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      <Input {...props} className="pl-8 font-mono text-xs" spellCheck={false} />
    </div>
  );
}

/** "New folder": where it goes and what it's called, with the folder that will be made (or why it can't be). */
function NewFolderFields({
  parent,
  name,
  check,
  onParent,
  onName,
}: {
  parent: string;
  name: string;
  /** The server's answer for the current parent and name; null while it's being asked. */
  check: NewFolderCheck | null;
  onParent: (v: string) => void;
  onName: (v: string) => void;
}) {
  const problem = name.trim() ? folderNameProblem(name) : null;
  const complete = Boolean(parent.trim() && name.trim()) && !problem;
  const error = problem ?? check?.error ?? null;
  const target = complete ? (check?.path ?? joinPath(parent.trim(), name.trim())) : null;
  return (
    <div className="grid gap-3">
      <Field label="Location" hint="The project folder is made inside this one." htmlFor="nb-parent">
        <div className="flex gap-2">
          <PathInput id="nb-parent" icon={<FolderOpen />} autoFocus={!parent} value={parent} onChange={(e) => onParent(e.target.value)} placeholder="C:\code" />
          <BrowseButton title="Choose where to make the project folder" startIn={parent} onPicked={onParent} />
        </div>
      </Field>
      <Field label="Folder name" htmlFor="nb-folder">
        <Input
          id="nb-folder"
          autoFocus={Boolean(parent)}
          value={name}
          maxLength={255}
          onChange={(e) => onName(e.target.value)}
          placeholder="my-app"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
        />
      </Field>
      {(target || error) && (
        <p className={cn('-mt-1 flex min-w-0 items-start gap-1.5 text-xs', error ? 'text-destructive' : 'text-muted-foreground')} aria-live="polite">
          {error ? (
            <CircleX className="mt-px size-3 shrink-0" />
          ) : check ? (
            <FolderPlus className="mt-px size-3 shrink-0" />
          ) : (
            <Spinner className="mt-px size-3" />
          )}
          <span className="min-w-0 break-all">
            {error ?? (
              <>
                Makes <span className="font-mono text-foreground">{target}</span>
              </>
            )}
          </span>
        </p>
      )}
    </div>
  );
}

/** What Create board will do about git, and the private GitHub repo it can also make. */
function GitSetupBox({
  init,
  newFolder,
  files,
  blocked,
  confirmMany,
  onConfirmMany,
  branch,
  offerGithub,
  account,
  github,
  owner,
  repoName,
  onGithub,
  onOwner,
  onRepoName,
}: {
  init: boolean;
  newFolder: boolean;
  /** An existing folder: the files its first commit would take. */
  files: { count: number; more: boolean } | null;
  /** Why git can't be set up in this folder. */
  blocked: string | null;
  confirmMany: boolean;
  onConfirmMany: (on: boolean) => void;
  branch: string;
  offerGithub: boolean;
  account: { data: GithubAccountView | undefined; loading: boolean };
  github: boolean;
  owner: string | undefined;
  repoName: string;
  onGithub: (on: boolean) => void;
  onOwner: (owner: string) => void;
  onRepoName: (name: string) => void;
}) {
  const recheck = useRecheckGithub();
  const acct = account.data;
  const nameOk = GITHUB_REPO_NAME_RE.test(repoName);
  if (blocked) {
    return (
      <p className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-[13px]">
        <CircleX className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <span className="min-w-0">
          Not a git repository, and T3 Orchestra won't start one here. {blocked}
        </span>
      </p>
    );
  }
  const what = newFolder
    ? 'it'
    : files
      ? files.more
        ? `the folder's files (more than ${files.count.toLocaleString()})`
        : `the folder's ${plural(files.count, 'file')}`
      : "the folder's files";
  return (
    <div className="grid gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5">
      {init && (
        <div className="flex gap-2 text-[13px]">
          <GitBranchPlus className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <p className="min-w-0">
            {newFolder ? 'Creating the board makes the folder with a README, starts' : 'Not a git repository yet. Creating the board starts'} a
            repository on <span className="font-mono text-xs">{branch.trim() || '…'}</span>, commits {what} and adds the project to
            T3 Code.
            <span className="mt-0.5 block text-xs text-muted-foreground">
              A .gitignore for dependencies, .env files and build output is added when there is none.
            </span>
          </p>
        </div>
      )}
      {init && files?.more && (
        <label className="flex cursor-pointer gap-2.5 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-2">
          <Checkbox checked={confirmMany} onCheckedChange={(c) => onConfirmMany(c === true)} className="mt-0.5" />
          <span className="min-w-0 text-[13px]">
            That's a lot for one project. Commit them all: this is the project's own folder.
          </span>
        </label>
      )}
      {offerGithub && (
        <div className={cn('grid gap-2', init && 'border-t border-border pt-2.5')}>
          <label className="flex cursor-pointer items-center gap-2.5">
            <Checkbox checked={github} disabled={!github && acct?.ok === false} onCheckedChange={(c) => onGithub(c === true)} />
            <span className="flex items-center gap-1.5 text-[13px] font-medium">
              <Lock className="size-3.5 text-muted-foreground" />
              Create a private GitHub repo
            </span>
          </label>
          {acct && !acct.ok && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6.5 text-xs text-muted-foreground">
              <span className="min-w-0">{acct.error}</span>
              <Button size="xs" variant="ghost" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
                {recheck.isPending ? <Spinner className="size-3" /> : <RefreshCw />}
                Check again
              </Button>
            </p>
          )}
          {github && account.loading && (
            <p className="flex items-center gap-1.5 pl-6.5 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Checking GitHub sign-in…
            </p>
          )}
          {github && acct?.ok && (
            <>
              <div className="flex min-w-0 items-center gap-1.5 pl-6.5">
                <Select
                  value={owner}
                  onValueChange={onOwner}
                  options={acct.owners.map((o) => ({ value: o, label: o }))}
                  className="w-36 shrink-0"
                  aria-label="GitHub owner"
                />
                <span className="text-muted-foreground">/</span>
                <Input
                  value={repoName}
                  maxLength={100}
                  onChange={(e) => onRepoName(e.target.value)}
                  className="font-mono text-xs"
                  spellCheck={false}
                  aria-label="GitHub repo name"
                  aria-invalid={nameOk ? undefined : true}
                />
              </div>
              <p className={cn('pl-6.5 text-xs', nameOk ? 'text-muted-foreground' : 'text-destructive')}>
                {nameOk
                  ? <>Added as the <span className="font-mono">origin</span> remote, and {init ? <span className="font-mono">{branch.trim()}</span> : 'the current branch'} is pushed to it.</>
                  : 'Use letters, digits, ".", "-" and "_" only.'}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

type Source = 't3' | 'path' | 'new';

function NewBoardForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const appSettings = useSettings();
  const t3Projects = useT3Projects();
  const validate = useValidateProject();
  const addToT3 = useAddToT3();
  const create = useCreateBoard();
  const setup = useSetupProject();
  const checkFolder = useCheckNewFolder();

  const [source, setSource] = useState<Source>('t3');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [path, setPath] = useState('');
  const [baseBranch, setBaseBranch] = useState<string | undefined>(undefined);
  const [validation, setValidation] = useState<ProjectValidation | null>(null);
  const [parent, setParent] = useState(() => readString(LAST_PARENT_KEY) ?? '');
  const [folderName, setFolderName] = useState('');
  const [folderCheck, setFolderCheck] = useState<{ key: string; result: NewFolderCheck } | null>(null);
  const [initBranch, setInitBranch] = useState('main');
  const [confirmMany, setConfirmMany] = useState(false);
  const [github, setGithub] = useState(false);
  const [ghOwner, setGhOwner] = useState<string | undefined>(undefined);
  /** null: follows the folder name. */
  const [ghName, setGhName] = useState<string | null>(null);
  const [learn, setLearn] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<BoardSettings>(DEFAULT_BOARD_SETTINGS);
  const seeded = useRef(false);
  const lastChecked = useRef('');

  useEffect(() => {
    if (appSettings.data && !seeded.current) {
      seeded.current = true;
      setSettings(appSettings.data.boardDefaults);
    }
  }, [appSettings.data]);

  // Nothing to pick from: start on the path field.
  useEffect(() => {
    if (t3Projects.isError || (t3Projects.data && t3Projects.data.length === 0)) setSource('path');
  }, [t3Projects.isError, t3Projects.data]);

  const runValidation = (projectPath: string, branch?: string) => {
    const p = projectPath.trim();
    if (!p) {
      setValidation(null);
      return;
    }
    const key = `${p}\u0000${branch ?? ''}`;
    if (key === lastChecked.current) return;
    lastChecked.current = key;
    validate.mutate(
      { projectPath: p, baseBranch: branch },
      {
        onSuccess: (v) => {
          if (lastChecked.current !== key) return;
          setValidation(v);
          if (!branch) setBaseBranch(v.baseBranch ?? v.currentBranch ?? undefined);
        },
        onError: (err) => {
          if (lastChecked.current !== key) return;
          lastChecked.current = '';
          setValidation(null);
          toast.error('Could not check the project', { description: errorMessage(err) });
        },
      },
    );
  };

  // Validate as you type (debounced); blur validates immediately.
  useEffect(() => {
    const t = setTimeout(() => runValidation(path), 700);
    return () => clearTimeout(t);
  }, [path]);

  // "New folder": ask the server whether the folder can be made, shortly after typing stops.
  const folderKey = parent.trim() && folderName.trim() && !folderNameProblem(folderName) ? `${parent.trim()}\u0000${folderName.trim()}` : '';
  useEffect(() => {
    if (source !== 'new' || !folderKey) return;
    const [p, n] = folderKey.split('\u0000') as [string, string];
    const t = setTimeout(() => checkFolder.mutate({ parent: p, name: n }, { onSuccess: (result) => setFolderCheck({ key: folderKey, result }) }), 300);
    return () => clearTimeout(t);
  }, [source, folderKey]);
  const newFolder = folderKey && folderCheck?.key === folderKey ? folderCheck.result : null;

  const onPathChange = (v: string) => {
    setPath(v);
    setBaseBranch(undefined);
    setConfirmMany(false);
    if (!nameTouched) setName(v.trim() ? basename(v.trim()) : '');
  };

  const onPick = (p: T3ProjectView) => {
    setPath(p.path);
    setBaseBranch(undefined);
    setConfirmMany(false);
    if (!nameTouched) setName(p.title);
    runValidation(p.path);
  };

  const onFolderName = (v: string) => {
    setFolderName(v);
    if (!nameTouched) setName(v.trim());
  };

  const picked = t3Projects.data?.find((p) => p.path === path);
  const onSource = (s: Source) => {
    setSource(s);
    if (!nameTouched) setName(s === 'new' ? folderName.trim() : (picked?.title ?? (path.trim() ? basename(path.trim()) : '')));
  };

  /** After a setup step stopped: carry on from the folder as it is now. */
  const continueWith = (r: ProjectSetupResult, val = r.validation) => {
    setSource((s) => (s === 'new' ? 'path' : s));
    setPath(r.projectPath);
    lastChecked.current = `${r.projectPath}\u0000`;
    setValidation(val);
    setBaseBranch(val.baseBranch ?? val.currentBranch ?? undefined);
  };

  const onAddToT3 = () => {
    addToT3.mutate(
      { projectPath: validation?.toplevel ?? path.trim() },
      {
        onSuccess: (v) => {
          setValidation(v);
          if (v.t3Known) toast.success('Project added to T3');
          else toast.error('T3 still does not know this project', { description: v.t3Error ?? undefined });
        },
        onError: (err) => toast.error('Could not add the project to T3', { description: errorMessage(err) }),
      },
    );
  };

  const isNew = source === 'new';
  const v = isNew ? null : validation;
  const threads = v?.t3Known ? (v.t3ThreadCount ?? 0) : 0;
  const importing = learn && threads > 0;
  const needsInit = isNew || Boolean(v?.exists && !v.isGitRepo);
  const offerGithub = needsInit || Boolean(v?.isGitRepo && !v.originUrl);
  const account = useGithubAccount(offerGithub);
  const owner = ghOwner && account.data?.owners.includes(ghOwner) ? ghOwner : (account.data?.login ?? undefined);
  const repoName = ghName ?? githubRepoName(isNew ? folderName : basename((v?.toplevel ?? path).trim()));
  const wantsGithub = offerGithub && github;

  const createWith = (projectPath: string, branch: string | undefined, afterSetup?: ProjectSetupResult) => {
    create.mutate(
      { ...settings, name: name.trim(), projectPath, baseBranch: branch, importFromT3: importing || undefined },
      {
        onSuccess: (board) => {
          const description = [
            afterSetup?.githubUrl && `GitHub repo: ${afterSetup.githubUrl}`,
            importing && `An agent is reading its ${plural(threads, 'T3 thread')} to learn about the project.`,
          ]
            .filter(Boolean)
            .join(' ');
          toast.success(`Created ${board.name}`, description ? { description } : undefined);
          onDone();
          navigate(`/b/${board.slug}`);
        },
        onError: (err) => {
          const details = isApiError(err, 'VALIDATION') && err.details && typeof err.details === 'object' && 'errors' in err.details ? (err.details as ProjectValidation) : null;
          if (afterSetup) continueWith(afterSetup, details ?? afterSetup.validation);
          else if (details) {
            setValidation(details);
            return;
          }
          toast.error('Could not create the board', { description: errorMessage(err) });
        },
      },
    );
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    if (!needsInit && !wantsGithub) {
      createWith(validation?.toplevel ?? path.trim(), baseBranch);
      return;
    }
    if (isNew) writeString(LAST_PARENT_KEY, parent.trim());
    const branch = needsInit ? initBranch.trim() : baseBranch;
    setup.mutate(
      {
        projectPath: isNew ? (newFolder?.path ?? '') : (v?.toplevel ?? path.trim()),
        createFolder: isNew || undefined,
        initBranch: needsInit ? branch : undefined,
        github: wantsGithub && owner ? { owner, name: repoName } : undefined,
        confirmManyFiles: confirmMany || undefined,
      },
      {
        onSuccess: (r) => {
          if (r.error || !r.validation.ok) {
            if (r.createdFolder || !isNew) continueWith(r);
            toast.error(r.error ? 'Setup stopped' : 'The project is set up but not ready for a board yet', {
              description: r.error ?? r.validation.errors.join(' '),
            });
            return;
          }
          createWith(r.projectPath, branch, r);
        },
        onError: (err) => toast.error('Could not set up the project', { description: errorMessage(err) }),
      },
    );
  };

  const checking = !isNew && validate.isPending;
  const branches = v?.branches ?? [];
  const busy = create.isPending || setup.isPending;
  const sourceReady = isNew ? Boolean(newFolder?.path && !newFolder.error) : Boolean(path.trim()) && !checking && (v ? v.ok || needsInit : true);
  const branchOk = !needsInit || branchNameOk(initBranch.trim());
  const folderOk = isNew || !v || (!v.setupBlocked && (!v.folderFiles?.more || confirmMany));
  const githubOk = !wantsGithub || (account.data?.ok === true && Boolean(owner) && GITHUB_REPO_NAME_RE.test(repoName));
  const canCreate = Boolean(name.trim()) && sourceReady && folderOk && branchOk && githubOk && !busy;

  return (
    <form onSubmit={submit} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <DialogHeader>
        <DialogTitle>New board</DialogTitle>
        <DialogDescription>A board points at one git repository registered in T3 Code.</DialogDescription>
      </DialogHeader>

      <Tabs value={source} onValueChange={(s) => onSource(s as Source)}>
        <TabsList>
          <TabsTrigger value="t3">
            <History />
            From T3 Code
          </TabsTrigger>
          <TabsTrigger value="path">
            <FolderGit2 />
            Existing folder
          </TabsTrigger>
          <TabsTrigger value="new">
            <FolderPlus />
            New folder
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {source === 't3' ? (
        <T3ProjectPicker selected={path || null} onPick={onPick} />
      ) : source === 'path' ? (
        <Field label="Project path" hint="The repository root, any folder inside it, or a folder to start a repository in." htmlFor="nb-path">
          <div className="flex gap-2">
            <PathInput
              id="nb-path"
              icon={<FolderGit2 />}
              autoFocus
              value={path}
              onChange={(e) => onPathChange(e.target.value)}
              onBlur={() => runValidation(path)}
              placeholder="C:\code\my-app"
              aria-invalid={v ? !v.exists : undefined}
            />
            <BrowseButton
              title="Choose the project folder"
              startIn={path}
              onPicked={(p) => {
                onPathChange(p);
                runValidation(p);
              }}
            />
          </div>
        </Field>
      ) : (
        <NewFolderFields
          parent={parent}
          name={folderName}
          check={newFolder}
          onParent={setParent}
          onName={onFolderName}
        />
      )}

      {!isNew && picked?.boardSlug && (
        <p className="-mt-2 text-xs text-muted-foreground">
          This project already has a board:{' '}
          <Link to={`/b/${picked.boardSlug}`} onClick={onDone} className="text-foreground underline underline-offset-2">
            open it
          </Link>
          , or make another one.
        </p>
      )}

      {!isNew && (v || checking) && (
        <div className="rounded-md border border-border bg-surface px-3 py-2">
          <ul className="flex flex-col">
            {v?.exists && !v.isGitRepo ? (
              <CheckRow ok pending={checking} icon={<FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />}>
                Folder <span className="font-mono text-xs break-all text-muted-foreground">{path.trim()}</span>
              </CheckRow>
            ) : (
              <CheckRow ok={Boolean(v?.isGitRepo)} pending={checking && !v}>
                {v?.isGitRepo ? (
                  <>
                    Git repository <span className="font-mono text-xs break-all text-muted-foreground">{v.toplevel}</span>
                  </>
                ) : (
                  'Not a git repository'
                )}
              </CheckRow>
            )}
            {v?.isGitRepo && (
              <CheckRow ok={v.baseBranchExists} pending={checking}>
                {v.baseBranchExists ? (
                  <>
                    Base branch <span className="font-mono text-xs">{v.baseBranch}</span> exists
                  </>
                ) : (
                  <>Base branch {v.baseBranch ? <span className="font-mono text-xs">{v.baseBranch}</span> : ''} not found</>
                )}
              </CheckRow>
            )}
            {v?.isGitRepo && (
              <CheckRow
                ok={v.t3Known}
                pending={checking || addToT3.isPending}
                action={
                  !v.t3Known && (
                    <Button size="xs" variant="secondary" onClick={onAddToT3} disabled={addToT3.isPending}>
                      <Plus />
                      Add to T3
                    </Button>
                  )
                }
              >
                {v.t3Known ? (
                  <>
                    T3 Code knows this project{' '}
                    <span className="text-xs text-muted-foreground">({threads ? plural(threads, 'thread') : 'no threads yet'})</span>
                  </>
                ) : (
                  'T3 Code does not know this project yet'
                )}
                {!v.t3Known && v.t3Error && <span className="block text-xs text-muted-foreground">{v.t3Error}</span>}
              </CheckRow>
            )}
          </ul>
          {v && !needsInit && v.errors.length > 0 && (
            <ul className="mt-1.5 border-t border-border pt-1.5 text-xs text-destructive">
              {v.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(isNew || (v && offerGithub)) && (
        <GitSetupBox
          init={needsInit}
          newFolder={isNew}
          files={v?.folderFiles ?? null}
          blocked={v?.setupBlocked ?? null}
          confirmMany={confirmMany}
          onConfirmMany={setConfirmMany}
          branch={initBranch}
          offerGithub={offerGithub}
          account={{ data: account.data, loading: account.isLoading }}
          github={github}
          owner={owner}
          repoName={repoName}
          onGithub={setGithub}
          onOwner={setGhOwner}
          onRepoName={setGhName}
        />
      )}

      {threads > 0 && (
        <label className="flex cursor-pointer gap-2.5 rounded-md border border-border px-3 py-2.5">
          <Checkbox checked={learn} onCheckedChange={(c) => setLearn(c === true)} className="mt-0.5" />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium">Learn about the project from its {plural(threads, 'T3 thread')}</span>
            <span className="block text-xs text-muted-foreground">
              An agent reads the threads and the code, then writes what the project is and where it stands into the board brief, which every
              agent on the board reads first. It changes no files. You can plan while it works.
            </span>
          </span>
        </label>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="nb-name">
          <Input
            id="nb-name"
            value={name}
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            placeholder="my-app"
          />
        </Field>
        {needsInit ? (
          <Field label="Branch" hint="The new repository's first branch, and the board's base branch." htmlFor="nb-branch">
            <Input
              id="nb-branch"
              value={initBranch}
              maxLength={100}
              onChange={(e) => setInitBranch(e.target.value)}
              className="font-mono text-xs"
              spellCheck={false}
              aria-invalid={branchOk ? undefined : true}
            />
          </Field>
        ) : (
          <Field label="Base branch" hint={v?.currentBranch ? `Root checkout is on ${v.currentBranch}.` : undefined}>
            <Select
              value={baseBranch}
              disabled={branches.length === 0}
              placeholder={checking ? 'Checking…' : source === 't3' ? 'Pick a project first' : 'Enter a path first'}
              onValueChange={(b) => {
                setBaseBranch(b);
                runValidation(path, b);
              }}
              options={branches.map((b) => ({ value: b, label: <span className="font-mono text-xs">{b}</span> }))}
            />
          </Field>
        )}
      </div>

      <div className="rounded-md border border-border">
        <button
          type="button"
          onClick={() => setShowSettings((s) => !s)}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
          aria-expanded={showSettings}
        >
          {showSettings ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
          <span className="text-[13px] font-medium">Board settings</span>
          {!showSettings && <span className="ml-2 truncate text-xs text-muted-foreground">{settingsSummary(settings)}</span>}
        </button>
        {showSettings && (
          <div className="max-h-[40vh] overflow-y-auto border-t border-border px-3 scrollbar-thin">
            <BoardSettingsFields mode="change" value={settings} onChange={(p) => setSettings((s) => ({ ...s, ...p }))} />
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canCreate}>
          {busy && <Spinner className="size-3.5 text-primary-foreground" />}
          {setup.isPending ? 'Setting up…' : importing ? 'Create and import' : 'Create board'}
        </Button>
      </DialogFooter>
    </form>
  );
}
