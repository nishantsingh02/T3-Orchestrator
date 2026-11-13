import { NOTIFY_TYPES, type NotificationSettings, type NotifyType } from '@t3-orchestra/shared';
import { Download, FolderOpen, Moon, PlugZap, Sun } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useBoards } from '@/api/boards';
import { api, errorMessage } from '@/api/client';
import { useHealth, useOpenPromptsDir, usePatchSettings, useSettings, useSettingsInfo, useTestConnection } from '@/api/settings';
import { BoardSettingsFields } from '@/components/BoardSettingsFields';
import { CommitInput, FieldRow, NumberInput, Section, SwitchRow } from '@/components/fields';
import { AppHeader } from '@/components/layout/AppHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Skeleton, Spinner } from '@/components/ui/spinner';
import { relativeTime } from '@/lib/time';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const NOTIFY_LABELS: Record<NotifyType, { label: string; hint: string }> = {
  task_attention: { label: 'Agent needs input', hint: '“#7 Add OAuth callback needs your input”' },
  plan_input: { label: 'Planner needs input', hint: '“Planner needs your input: …”' },
  plan_ready: { label: 'Plan ready for review', hint: '“Plan ready: 12 tasks proposed”' },
  human_review: { label: 'Task ready for review', hint: '“#7 ready for review (AI passed)”' },
  task_failed: { label: 'Task failed', hint: '“#7 failed: run interrupted”' },
  board_done: { label: 'Board finished', hint: 'Every non-discarded task is done' },
  t3_down: { label: 'T3 unreachable', hint: 'T3 Code not reachable for more than 60s' },
};

const NAV = [
  ['t3', 'T3 Code'],
  ['polling', 'Polling'],
  ['parallel', 'Parallel'],
  ['notifications', 'Notifications'],
  ['defaults', 'New board defaults'],
  ['prompts', 'Prompts'],
  ['data', 'Data'],
  ['appearance', 'Appearance'],
] as const;

function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-xs break-all', className)}>{children}</span>;
}

export function SettingsPage() {
  const settings = useSettings();
  const info = useSettingsInfo();
  const health = useHealth();
  const patch = usePatchSettings();
  const test = useTestConnection();
  const openPrompts = useOpenPromptsDir();
  const boards = useBoards();
  const { theme, setTheme } = useTheme();
  const [exportBoard, setExportBoard] = useState<string | undefined>(undefined);

  const s = settings.data;
  const h = health.data;
  const i = info.data;
  const exportId = exportBoard ?? boards.data?.[0]?.id;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppHeader>
        <span className="text-[13px] font-medium">Settings</span>
      </AppHeader>
      <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex max-w-5xl gap-8 px-4 py-6 sm:px-6">
          <nav className="sticky top-6 hidden h-fit w-44 shrink-0 flex-col gap-0.5 lg:flex" aria-label="Settings sections">
            {NAV.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground">
                {label}
              </a>
            ))}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col gap-5">
            <h1 className="text-[18px] font-semibold tracking-tight">Settings</h1>
            {settings.isError && (
              <p className="rounded-md border border-destructive/30 bg-destructive/8 p-3 text-[13px] text-destructive">
                Could not load settings: {errorMessage(settings.error)}
              </p>
            )}
            {!s ? (
              <div className="flex flex-col gap-4">
                <Skeleton className="h-40" />
                <Skeleton className="h-40" />
              </div>
            ) : (
              <>
                <Section
                  id="t3"
                  title="T3 Code"
                  description="T3 Orchestra drives T3 Code through its CLI. The T3 desktop app must be running."
                  actions={
                    <Button size="sm" variant="secondary" onClick={() => test.mutate()} disabled={test.isPending}>
                      {test.isPending ? <Spinner className="size-3.5" /> : <PlugZap />}
                      Test connection
                    </Button>
                  }
                >
                  <FieldRow label="Status">
                    {h ? (
                      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                        <Badge variant={h.cliFound ? 'success' : 'destructive'}>{h.cliFound ? 'CLI found' : 'CLI missing'}</Badge>
                        <Badge variant={h.serverReachable ? 'success' : 'destructive'}>
                          {h.serverReachable ? 'Server reachable' : 'Server down'}
                        </Badge>
                        {h.fake && <Badge variant="outline">Fake T3 mode</Badge>}
                      </div>
                    ) : (
                      <Skeleton className="h-5 w-40" />
                    )}
                  </FieldRow>
                  {h?.error && (
                    <p className="py-2 font-mono text-[11.5px] break-all text-destructive">{h.error}</p>
                  )}
                  <FieldRow label="Detected version">
                    <Mono className="block sm:text-right">{h?.version ?? '—'}</Mono>
                  </FieldRow>
                  {i?.launcher && (
                    <FieldRow label="Launcher" hint={`How the CLI is spawned (${i.launcher.kind}).`}>
                      <Mono className="block text-muted-foreground sm:text-right">{i.launcher.command}</Mono>
                    </FieldRow>
                  )}
                  <FieldRow
                    label="CLI path override"
                    hint={i?.launcher?.cliPath ? <>Auto-detected: <Mono>{i.launcher.cliPath}</Mono></> : 'Leave empty to auto-detect.'}
                  >
                    <CommitInput
                      mono
                      nullable
                      value={s.t3CliPath}
                      placeholder="auto-detect"
                      onCommit={(t3CliPath) => patch.mutate({ t3CliPath })}
                    />
                  </FieldRow>
                  <SwitchRow
                    label="Settle threads of done tasks"
                    hint="Once a task is Done, its task and review threads move to Settled in T3’s sidebar. Each task only once, so a thread you bring back stays active."
                    checked={s.settleDoneThreads}
                    onCheckedChange={(settleDoneThreads) => patch.mutate({ settleDoneThreads })}
                  />
                  {h && (
                    <p className="py-2 text-xs text-muted-foreground">Last checked {relativeTime(h.checkedAt)}.</p>
                  )}
                </Section>

                <Section id="polling" title="Polling" description="How often the backend asks T3 for thread status.">
                  <FieldRow label="While runs are active" hint="Also used while an agent waits for you.">
                    <NumberInput value={s.pollActiveMs} min={500} max={60_000} suffix="ms" onCommit={(pollActiveMs) => patch.mutate({ pollActiveMs })} />
                  </FieldRow>
                  <FieldRow label="When idle">
                    <NumberInput value={s.pollIdleMs} min={1000} max={600_000} suffix="ms" onCommit={(pollIdleMs) => patch.mutate({ pollIdleMs })} />
                  </FieldRow>
                  <FieldRow label="Stale threshold" hint="Cards show “quiet for 18m” after this long without thread activity. Never fails a task.">
                    <NumberInput
                      value={s.staleAfterMinutes}
                      min={1}
                      max={24 * 60}
                      suffix="min"
                      onCommit={(staleAfterMinutes) => patch.mutate({ staleAfterMinutes })}
                    />
                  </FieldRow>
                </Section>

                <Section id="parallel" title="Parallel" description="Limits across every board. Each board also has its own limit.">
                  <FieldRow label="Global max parallel" hint="Tasks implementing or in AI review across all boards.">
                    <NumberInput value={s.globalMaxParallel} min={1} max={50} onCommit={(globalMaxParallel) => patch.mutate({ globalMaxParallel })} />
                  </FieldRow>
                  <SwitchRow
                    label="Pause all"
                    hint="Stop auto-run from starting new tasks on every board. Running threads continue."
                    checked={s.pauseAll}
                    onCheckedChange={(pauseAll) => patch.mutate({ pauseAll })}
                  />
                </Section>

                <Section id="notifications" title="Notifications" description="Desktop toasts come from the backend, so they work with this tab closed.">
                  <SwitchRow
                    label="Desktop notifications"
                    hint="Clicking one opens the task in T3 Orchestra."
                    checked={s.notifications.desktop}
                    onCheckedChange={(desktop) => patch.mutate({ notifications: { desktop } })}
                  />
                  <SwitchRow
                    label="Sound"
                    checked={s.notifications.sound}
                    onCheckedChange={(sound) => patch.mutate({ notifications: { sound } })}
                  />
                  {NOTIFY_TYPES.map((t) => (
                    <SwitchRow
                      key={t}
                      label={NOTIFY_LABELS[t].label}
                      hint={NOTIFY_LABELS[t].hint}
                      checked={s.notifications[t]}
                      onCheckedChange={(on) => patch.mutate({ notifications: { [t]: on } as Partial<NotificationSettings> })}
                    />
                  ))}
                </Section>

                <Section id="defaults" title="Defaults for new boards" description="Prefilled in the New board dialog. Existing boards keep their settings.">
                  <BoardSettingsFields value={s.boardDefaults} onChange={(p) => patch.mutate({ boardDefaults: p })} />
                </Section>

                <Section
                  id="prompts"
                  title="Prompts"
                  description="Agent prompt templates. A file with the same name in the overrides folder replaces the built-in one."
                  actions={
                    <Button size="sm" variant="secondary" onClick={() => openPrompts.mutate()} disabled={openPrompts.isPending}>
                      <FolderOpen />
                      Open overrides folder
                    </Button>
                  }
                >
                  {i ? (
                    <>
                      <FieldRow label="Overrides folder">
                        <Mono className="block text-muted-foreground sm:text-right">{i.promptsDir}</Mono>
                      </FieldRow>
                      <div className="py-2.5">
                        <ul className="grid gap-1 sm:grid-cols-2">
                          {i.templates.map((t) => {
                            const overridden = i.overriddenPrompts.includes(t);
                            return (
                              <li key={t} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5">
                                <Mono>{t}</Mono>
                                {overridden ? <Badge variant="warning">overridden</Badge> : <span className="text-2xs text-muted-foreground">built-in</span>}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </>
                  ) : info.isError ? (
                    <p className="py-3 text-[13px] text-muted-foreground">Could not load: {errorMessage(info.error)}</p>
                  ) : (
                    <Skeleton className="my-3 h-16" />
                  )}
                </Section>

                <Section id="data" title="Data" description="Everything lives in a local SQLite database.">
                  <FieldRow label="Data directory">
                    <Mono className="block text-muted-foreground sm:text-right">{i?.dataDir ?? '—'}</Mono>
                  </FieldRow>
                  {i && (
                    <FieldRow label="Server">
                      <Mono className="block text-muted-foreground sm:text-right">{i.publicUrl || `127.0.0.1:${i.port}`}</Mono>
                    </FieldRow>
                  )}
                  <FieldRow label="Export a board" hint="Full JSON dump: tasks, runs, findings, events, plans.">
                    <div className="flex gap-2">
                      <Select
                        className="min-w-0 flex-1"
                        value={exportId}
                        disabled={!boards.data?.length}
                        placeholder="No boards"
                        onValueChange={setExportBoard}
                        options={(boards.data ?? []).map((b) => ({ value: b.id, label: b.name }))}
                      />
                      <Button variant="secondary" size="icon" asChild disabled={!exportId}>
                        <a
                          href={exportId ? api.boardExportUrl(exportId) : undefined}
                          download
                          aria-label="Download export"
                          aria-disabled={!exportId}
                        >
                          <Download />
                        </a>
                      </Button>
                    </div>
                  </FieldRow>
                </Section>

                <Section id="appearance" title="Appearance">
                  <FieldRow label="Theme">
                    <div className="flex rounded-md border border-border p-0.5 sm:ml-auto sm:w-fit">
                      <Button size="xs" variant={theme === 'dark' ? 'secondary' : 'ghost'} className="border-0" onClick={() => setTheme('dark')}>
                        <Moon />
                        Dark
                      </Button>
                      <Button size="xs" variant={theme === 'light' ? 'secondary' : 'ghost'} className="border-0" onClick={() => setTheme('light')}>
                        <Sun />
                        Light
                      </Button>
                    </div>
                  </FieldRow>
                </Section>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
