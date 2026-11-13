import { Moon, Pause, Play, Settings, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useHealth, usePatchSettings, useSettings } from '@/api/settings';
import { useStreamStatus } from '@/api/stream';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 128 128" className={cn('size-5', className)} aria-hidden>
      <rect width="128" height="128" rx="26" className="fill-foreground/8" />
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        className="fill-foreground"
      />
      <rect x="33" y="104" width="62" height="8" rx="4" className="fill-stage-running" />
    </svg>
  );
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <Tip content={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
      <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label="Toggle theme">
        {theme === 'dark' ? <Sun /> : <Moon />}
      </Button>
    </Tip>
  );
}

/** Global "Pause all": stops auto-run from starting anything on any board. */
export function PauseAllToggle() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const paused = settings.data?.pauseAll ?? false;
  return (
    <Tip
      content={
        paused
          ? 'Auto-run is paused on every board. Running threads continue.'
          : 'Pause auto-run on every board (running threads continue)'
      }
    >
      <Button
        variant={paused ? 'warning' : 'ghost'}
        size="sm"
        disabled={!settings.data}
        onClick={() => patch.mutate({ pauseAll: !paused })}
        aria-pressed={paused}
      >
        {paused ? <Play /> : <Pause />}
        {paused ? 'Resume all' : 'Pause all'}
      </Button>
    </Tip>
  );
}

function ConnectionDot() {
  const status = useStreamStatus();
  const health = useHealth();
  if (status === 'open' && !health.data?.fake) return null;
  return (
    <div className="flex items-center gap-1.5">
      {health.data?.fake && (
        <Tip content="The server is using the scripted fake T3 client (T3ORCHESTRA_FAKE_T3=1). No real agents run.">
          <Badge variant="outline" size="sm">
            Fake T3 mode
          </Badge>
        </Tip>
      )}
      {status !== 'open' && (
        <Tip content="Live updates are disconnected; reconnecting…">
          <span className="flex items-center gap-1 text-2xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-warning" />
            {status === 'connecting' ? 'connecting' : 'reconnecting'}
          </span>
        </Tip>
      )}
    </div>
  );
}

/** Top bar shared by every page: logo/breadcrumb on the left, global controls on the right. */
export function AppHeader({ children, actions }: { children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      <Link to="/" className="flex shrink-0 items-center gap-2 rounded-md px-1 py-1 hover:bg-accent" aria-label="All boards">
        <Logo />
        <span className="hidden text-[13px] font-semibold tracking-tight sm:inline">T3 Orchestra</span>
      </Link>
      {children && <span className="text-muted-foreground/50">/</span>}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <div className="flex shrink-0 items-center gap-1">
        <ConnectionDot />
        {actions}
        <PauseAllToggle />
        <Tip content="Settings">
          <Button variant="ghost" size="icon-sm" asChild>
            <Link to="/settings" aria-label="Settings">
              <Settings />
            </Link>
          </Button>
        </Tip>
        <ThemeToggle />
      </div>
    </header>
  );
}
