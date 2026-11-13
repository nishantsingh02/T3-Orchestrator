import { RefreshCw, TriangleExclamationPoint, WifiOff } from 'lucide-react';
import { isApiError } from '@/api/client';
import { useHealth, useTestConnection } from '@/api/settings';
import { useStreamStatus } from '@/api/stream';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

/** Red banner when T3 Code isn't reachable; amber when our own server is. */
export function HealthBanner() {
  const health = useHealth();
  const stream = useStreamStatus();
  const test = useTestConnection();

  const err = health.error;
  const serverDown =
    health.isError && (!isApiError(err) || err.code === 'NETWORK' || err.status >= 500 || stream === 'reconnecting');
  if (serverDown) {
    return (
      <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs text-warning">
        <WifiOff className="size-3.5 shrink-0" />
        <span className="font-medium">Can't reach the T3 Orchestra server.</span>
        <span className="text-muted-foreground">Is it running on port 4417? Reconnecting…</span>
      </div>
    );
  }

  const h = health.data;
  if (!h || (h.cliFound && h.serverReachable)) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-destructive/30 bg-destructive/12 px-4 py-1.5 text-xs">
      <TriangleExclamationPoint className="size-3.5 shrink-0 text-destructive" />
      <span className="font-medium text-destructive">T3 Code isn't running. Start the T3 app to continue.</span>
      <span className="min-w-0 truncate text-muted-foreground">
        {!h.cliFound ? 'The t3 CLI was not found.' : (h.error ?? 'The T3 server did not answer.')} Auto-run is paused
        until it's back.
      </span>
      {h.fake && <span className="font-mono text-2xs text-muted-foreground">fake t3</span>}
      <Button variant="ghost" size="xs" className="ml-auto" onClick={() => test.mutate()} disabled={test.isPending}>
        {test.isPending ? <Spinner className="size-3" /> : <RefreshCw />}
        Check again
      </Button>
    </div>
  );
}
