// The "Run project" popover: the live run (status, link, output) or the ways to run the project.
import {
  isLiveRunStatus,
  recipeParts,
  type BoardView,
  type ProjectKind,
  type ProjectRunView,
  type RunConfig,
  type RunMode,
  type RunRecipe,
} from '@t3-orchestra/shared';
import {
  AppWindow,
  ArrowLeft,
  Check,
  Container,
  Copy,
  ExternalLink,
  Globe,
  Play,
  RotateCcw,
  Settings2,
  Square,
  SquareTerminal,
  TriangleExclamationPoint,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { usePatchBoard } from '@/api/boards';
import { errorMessage, isApiError, type RunTarget } from '@/api/client';
import { useFixRun, useRunInfo, useRunLog, useStartRun, useStopRun } from '@/api/projectRuns';
import { useBoardTasks } from '@/api/tasks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { LANE_LABELS, laneFor } from '@/lib/stage';
import { cn } from '@/lib/utils';

export type RunPanelView = 'run' | 'choose';

const KIND_ICON: Record<ProjectKind, ReactNode> = {
  web: <Globe />,
  app: <AppWindow />,
  console: <SquareTerminal />,
};

const MODE_OPTIONS = [
  { value: 'background', label: 'Show output here' },
  { value: 'terminal', label: 'In its own window' },
] as const satisfies ReadonlyArray<{ value: RunMode; label: string }>;

/** `http://localhost:5173/` → `localhost:5173` */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function StatusDot({ run, className }: { run: ProjectRunView; className?: string }) {
  // Web runs are settled once their URL answers; windows and console programs once they run.
  const settled =
    !run.stopping &&
    (run.status === 'ready' || (run.status === 'running' && (run.recipe.kind !== 'web' || run.recipe.mode === 'terminal')));
  const color = settled
    ? 'bg-success'
    : run.status === 'failed'
      ? 'bg-destructive'
      : isLiveRunStatus(run.status)
        ? 'animate-pulse bg-warning'
        : 'bg-border-strong';
  return <span className={cn('size-1.5 shrink-0 rounded-full', color, className)} />;
}

/** The Stop button's tooltip: it also runs the project's own stop command, when there is one. */
export function stopHint(run: ProjectRunView): string {
  return run.recipe.stop ? `Stop (runs ${run.recipe.stop})` : 'Stop';
}

function statusText(run: ProjectRunView): string {
  const parts = recipeParts(run.recipe);
  const steps = parts[0]!.steps;
  if (run.stopping && isLiveRunStatus(run.status)) return 'Stopping…';
  switch (run.status) {
    case 'starting':
      return steps.length > 1 ? `${steps[run.step]?.label ?? 'Starting'}…` : 'Starting…';
    case 'running':
      if (run.recipe.mode === 'terminal' && parts.length === 1) return 'Open in its own window';
      return run.url ? 'Waiting for it to answer…' : 'Running';
    case 'ready':
      return 'Running';
    case 'exited':
      return run.exitCode === 0 || run.exitCode === null ? 'Finished' : `Exited (${run.exitCode})`;
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
  }
}

/** What to send to start this recipe again. */
function restartBody(recipe: RunRecipe) {
  if (recipe.source !== 'custom') return { recipeId: recipe.id };
  return { config: { command: recipe.steps[0]?.command ?? '', mode: recipe.mode, cwd: recipe.cwd } };
}

function commandSummary(recipe: RunRecipe): ReactNode {
  const parts = recipeParts(recipe);
  return parts.map((p, i) => (
    <span key={i} className="block truncate">
      {p.steps.map((s) => s.command).join('  →  ')}
      {(parts.length > 1 || p.cwd) && <span className="text-muted-foreground/70">{`  (in ${p.cwd || 'root'})`}</span>}
    </span>
  ));
}

interface Props {
  target: RunTarget;
  board: BoardView;
  /** Shown in the heading: the board name, or "#12" for a task worktree. */
  title: string;
  run: ProjectRunView | null;
  view: RunPanelView;
  onView: (v: RunPanelView) => void;
  /** Closes the popover (before going to a task). */
  onClose: () => void;
}

export function RunPanel(p: Props) {
  if (p.view === 'choose' || !p.run) return <Chooser {...p} />;
  return <LiveRun {...p} run={p.run} />;
}

// ---- the run ---------------------------------------------------------------------------

function LiveRun({ target, board, run, onView, onClose }: Props & { run: ProjectRunView }) {
  const start = useStartRun();
  const stop = useStopRun();
  const live = isLiveRunStatus(run.status);
  const stopping = live && run.stopping;
  const parts = recipeParts(run.recipe);
  const windowed = run.recipe.mode === 'terminal' && parts.length === 1;

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-start gap-3 border-b border-border px-3.5 pt-3 pb-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground [&_svg]:size-3.5">{KIND_ICON[run.recipe.kind]}</span>
            <span className="truncate text-[13px] font-semibold">{run.recipe.label}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <StatusDot run={run} />
              {statusText(run)}
            </span>
          </div>
          <div className="mt-1 font-mono text-[11px] leading-relaxed text-muted-foreground">{commandSummary(run.recipe)}</div>
        </div>
        <div className="-mr-1 flex shrink-0 items-center gap-0.5">
          <Tip content={live ? 'Restart' : 'Run again'}>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={start.isPending || stop.isPending || stopping}
              onClick={() => start.mutate({ target, body: restartBody(run.recipe) })}
              aria-label={live ? 'Restart' : 'Run again'}
            >
              {start.isPending ? <Spinner className="size-3.5" /> : live ? <RotateCcw /> : <Play />}
            </Button>
          </Tip>
          {live && (
            <Tip content={stopHint(run)}>
              <Button variant="ghost" size="icon-sm" disabled={stop.isPending || stopping} onClick={() => stop.mutate(run)} aria-label="Stop">
                {stop.isPending || stopping ? <Spinner className="size-3.5" /> : <Square className="fill-current" />}
              </Button>
            </Tip>
          )}
        </div>
      </div>

      {run.url && (live || run.status === 'exited') && <UrlBar url={run.url} ready={run.status === 'ready' && !stopping} />}
      {live && run.background && !stopping && (
        <Note icon={<Container />}>
          The command finished, but the app keeps running in the background.{' '}
          {run.recipe.stop ? (
            <>
              Stop runs <code className="font-mono text-[11px] text-foreground">{run.recipe.stop}</code>.
            </>
          ) : (
            'Stop ends what it left running.'
          )}
        </Note>
      )}
      {live && windowed && (
        <Note icon={<SquareTerminal />}>It runs in its own console window. Close that window, or press Stop, to end it.</Note>
      )}
      {live && !windowed && run.recipe.kind === 'app' && !run.url && <Note icon={<AppWindow />}>The app opens in its own window.</Note>}
      {run.error && <Failure run={run} board={board} onClose={onClose} />}

      <RunLog runId={run.id} short={windowed} />

      <div className="flex items-center gap-2 border-t border-border px-2.5 py-1.5">
        <Button variant="ghost" size="xs" onClick={() => onView('choose')}>
          <Settings2 />
          Change how it runs
        </Button>
        <span className="ml-auto truncate font-mono text-[10.5px] text-muted-foreground" title={run.dir}>
          {run.dir}
        </span>
      </div>
    </div>
  );
}

/** The error, and "Fix with AI": a new task for a board run, or the error back to the task's own agent. */
function Failure({ run, board, onClose }: { run: ProjectRunView; board: BoardView; onClose: () => void }) {
  const fix = useFixRun();
  const tasks = useBoardTasks(board.id).data ?? [];
  const navigate = useNavigate();
  const own = run.taskId ? tasks.find((t) => t.id === run.taskId) : undefined;
  const fixTask = run.fixTaskId ? tasks.find((t) => t.id === run.fixTaskId) : undefined;
  const ownBusy = own?.stage === 'implementing' || own?.stage === 'ai_review';
  const toOwnAgent = own && (own.stage === 'human_review' || own.stage === 'failed');
  const hint = toOwnAgent
    ? `Sends this error and the output to #${own.number}'s agent, which fixes its branch`
    : 'Creates a task with this error and the output, and starts it';

  return (
    <div className="border-b border-border bg-destructive/8 px-3.5 py-2 text-xs">
      <div className="flex items-start gap-2 text-destructive">
        <TriangleExclamationPoint className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{run.error}</span>
        {run.status === 'failed' && !run.fixTaskId && !ownBusy && (
          <Tip content={hint}>
            <Button
              size="xs"
              variant="secondary"
              className="-my-0.5 shrink-0 text-foreground"
              disabled={fix.isPending}
              onClick={() => fix.mutate({ run })}
            >
              {fix.isPending ? <Spinner className="size-3 text-current" /> : <WandSparkles />}
              Fix with AI
            </Button>
          </Tip>
        )}
      </div>
      {ownBusy && !run.fixTaskId && (
        <p className="mt-1 pl-5.5 text-muted-foreground">
          #{own.number}'s agent is working. Fix with AI is offered once the task is back in Human Review.
        </p>
      )}
      {run.fixTaskId && (
        <div className="mt-1.5 flex items-center gap-2 pl-5.5 text-muted-foreground">
          <WandSparkles className="size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            {!fixTask
              ? 'An agent is fixing it.'
              : fixTask.id === run.taskId
                ? `Sent to this task's agent (${LANE_LABELS[laneFor(fixTask)]}). Run it again once it's back in Human Review.`
                : `An agent is fixing it in #${fixTask.number} (${LANE_LABELS[laneFor(fixTask)]}).`}
          </span>
          {fixTask && fixTask.id !== run.taskId && (
            <Button
              size="xs"
              variant="ghost"
              className="-my-0.5"
              onClick={() => {
                onClose();
                navigate(`/b/${board.slug}/t/${fixTask.number}`);
              }}
            >
              Open #{fixTask.number}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3.5 py-2 text-xs text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
      {icon}
      <span>{children}</span>
    </div>
  );
}

function UrlBar({ url, ready }: { url: string; ready: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      toast.error('Could not copy', { description: errorMessage(err) });
    }
  };
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-3.5 py-2">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={cn('min-w-0 flex-1 truncate font-mono text-[13px] font-medium hover:underline', ready ? 'text-primary' : 'text-muted-foreground')}
      >
        {url}
      </a>
      <Tip content={copied ? 'Copied' : 'Copy link'}>
        <Button variant="ghost" size="icon-sm" onClick={() => void copy()} aria-label="Copy link">
          {copied ? <Check /> : <Copy />}
        </Button>
      </Tip>
      <Button size="sm" asChild>
        <a href={url} target="_blank" rel="noreferrer">
          <ExternalLink />
          Open
        </a>
      </Button>
    </div>
  );
}

function RunLog({ runId, short }: { runId: string; short?: boolean }) {
  const log = useRunLog(runId);
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const text = log.data?.text ?? '';

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className={cn(
        'overflow-auto bg-background/60 px-3.5 py-2 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap break-words text-foreground/85 scrollbar-thin',
        short ? 'h-24' : 'h-64',
      )}
      aria-label="Output"
    >
      {log.isLoading ? <span className="text-muted-foreground">Loading output…</span> : text || <span className="text-muted-foreground">No output yet.</span>}
    </pre>
  );
}

// ---- choosing --------------------------------------------------------------------------

function Chooser({ target, board, title, run, onView }: Props) {
  const info = useRunInfo(target, true);
  const start = useStartRun();
  const patch = usePatchBoard();
  const recipes = info.data?.recipes ?? [];
  const nothing = info.isSuccess && recipes.length === 0;

  const go = (body: Parameters<typeof start.mutate>[0]['body']) =>
    start.mutate({ target, body }, { onSuccess: () => onView('run') });

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-start gap-2 border-b border-border px-3.5 pt-3 pb-2.5">
        {run && (
          <Button variant="ghost" size="icon-xs" className="-ml-1.5" onClick={() => onView('run')} aria-label="Back to the run">
            <ArrowLeft />
          </Button>
        )}
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">How to run {title}</p>
          <p className="truncate text-xs text-muted-foreground" title={info.data?.dir}>
            {info.data ? `Detected from the files in ${info.data.dir}` : 'Looking at the project…'}
          </p>
        </div>
      </div>

      <div className="max-h-[min(340px,45dvh)] overflow-y-auto scrollbar-thin">
        {info.isLoading && (
          <div className="flex items-center gap-2 px-3.5 py-4 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            Looking at the project…
          </div>
        )}
        {info.isError && (
          <p className="px-3.5 py-3 text-xs text-destructive">{errorMessage(info.error)}</p>
        )}
        {nothing && (
          <p className="px-3.5 py-3 text-xs text-muted-foreground">
            Couldn't tell how to run this project from its files. Enter the command you use below.
          </p>
        )}
        {recipes.map((r, i) => (
          <RecipeRow
            key={r.id}
            recipe={r}
            best={i === 0}
            current={run?.recipe.id === r.id && isLiveRunStatus(run.status)}
            pending={start.isPending && start.variables?.body?.recipeId === r.id}
            onRun={() => go({ recipeId: r.id })}
            onForget={r.source === 'custom' ? () => patch.mutate({ board, patch: { runConfig: null } }) : undefined}
          />
        ))}
      </div>

      <CustomCommand
        key={board.runConfig?.command ?? ''}
        saved={board.runConfig}
        autoFocus={nothing}
        pending={start.isPending && Boolean(start.variables?.body?.config)}
        error={start.error && isApiError(start.error, 'VALIDATION') ? errorMessage(start.error) : null}
        onRun={(config, save) => go({ config, save })}
      />
    </div>
  );
}

function RecipeRow({
  recipe,
  best,
  current,
  pending,
  onRun,
  onForget,
}: {
  recipe: RunRecipe;
  best: boolean;
  current: boolean;
  pending: boolean;
  onRun: () => void;
  onForget?: () => void;
}) {
  return (
    <div className="group flex items-start gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0 hover:bg-accent/40">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-3.5">{KIND_ICON[recipe.kind]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-medium">{recipe.label}</span>
          {best && <Badge variant="primary">Best match</Badge>}
          {recipe.mode === 'terminal' && <Badge variant="outline">Own window</Badge>}
          {current && <Badge variant="success">Running</Badge>}
        </div>
        <div className="mt-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground">{commandSummary(recipe)}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {recipe.reason}
          {onForget && (
            <>
              {' · '}
              <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={onForget}>
                Forget it
              </button>
            </>
          )}
        </p>
        {recipe.warning && (
          <p className="mt-1 flex items-start gap-1 text-xs text-warning">
            <TriangleExclamationPoint className="mt-px size-3 shrink-0" />
            {recipe.warning}
          </p>
        )}
      </div>
      <Button size="xs" variant={best ? 'default' : 'secondary'} disabled={pending} onClick={onRun}>
        {pending ? <Spinner className="size-3 text-current" /> : <Play />}
        Run
      </Button>
    </div>
  );
}

function CustomCommand({
  saved,
  autoFocus,
  pending,
  error,
  onRun,
}: {
  saved: RunConfig | null;
  /** Nothing was detected, so this form is the way forward. */
  autoFocus: boolean;
  pending: boolean;
  error: string | null;
  onRun: (config: RunConfig, save: boolean) => void;
}) {
  const [command, setCommand] = useState(saved?.command ?? '');
  const [mode, setMode] = useState<RunMode>(saved?.mode ?? 'background');
  const [cwd, setCwd] = useState(saved?.cwd ?? '');
  const [save, setSave] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const submit = () => {
    if (command.trim()) onRun({ command: command.trim(), mode, cwd: cwd.trim() }, save);
  };

  return (
    <form
      className="flex flex-col gap-2 border-t border-border bg-surface/60 px-3.5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Label htmlFor="run-command" className="text-foreground">
        Your own command
      </Label>
      <Input
        ref={inputRef}
        id="run-command"
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder="npm run dev"
        spellCheck={false}
        autoComplete="off"
        className="h-7 font-mono text-xs"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select<RunMode> size="sm" value={mode} onValueChange={setMode} options={MODE_OPTIONS} className="w-40" aria-label="Where it runs" />
        <Input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="Folder (optional)"
          aria-label="Folder, relative to the project"
          spellCheck={false}
          className="h-7 w-36 font-mono text-xs"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={save} onCheckedChange={(v) => setSave(v === true)} />
          Save for this board
        </label>
        <Button type="submit" size="xs" className="ml-auto" disabled={!command.trim() || pending}>
          {pending ? <Spinner className="size-3 text-current" /> : <Play />}
          Run
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
