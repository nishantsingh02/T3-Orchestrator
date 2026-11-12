// T3 health monitor (spec §15.1): checks every 10s and right after CLI failures.
import type { HealthView } from '@t3-orchestra/shared';
import type { Bus } from '../bus.ts';
import { childLog } from '../log.ts';
import { nowIso } from '../util.ts';
import type { T3Client } from './T3Client.ts';

const log = childLog('health');

export class HealthMonitor {
  private current: HealthView = { cliFound: false, serverReachable: false, checkedAt: nowIso(), error: 'not checked yet' };
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<HealthView> | null = null;
  /** When T3 went down (ms epoch), or null while healthy. */
  downSince: number | null = null;

  constructor(
    private readonly t3: T3Client,
    private readonly bus: Bus,
    private readonly intervalMs = 10_000,
    private readonly onChange?: (h: HealthView, prev: HealthView) => void,
  ) {}

  get(): HealthView {
    return this.current;
  }

  healthy(): boolean {
    return this.current.cliFound && this.current.serverReachable;
  }

  start(): void {
    const loop = async () => {
      await this.check();
      this.timer = setTimeout(loop, this.intervalMs);
    };
    void loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Re-checks now (deduplicated while a check is running). */
  check(): Promise<HealthView> {
    this.inflight ??= (async () => {
      try {
        const h = await this.t3.health();
        return this.set({ ...h, checkedAt: nowIso() });
      } catch (err) {
        return this.set({ cliFound: false, serverReachable: false, error: String(err), checkedAt: nowIso() });
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private set(h: HealthView): HealthView {
    const prev = this.current;
    this.current = h;
    const ok = h.cliFound && h.serverReachable;
    if (!ok && this.downSince === null) this.downSince = Date.now();
    if (ok) this.downSince = null;
    if (prev.cliFound !== h.cliFound || prev.serverReachable !== h.serverReachable || prev.error === 'not checked yet') {
      log.info({ cliFound: h.cliFound, serverReachable: h.serverReachable, error: h.error }, 'T3 health changed');
      this.bus.emit('health', h);
      this.onChange?.(h, prev);
    }
    return h;
  }
}
