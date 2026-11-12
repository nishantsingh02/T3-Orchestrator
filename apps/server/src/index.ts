// Boot (spec §11.1): settings → migrate DB → health → reconciler → HTTP.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { adoptPreRenameData, env, loadConfig } from './config.ts';
import { openDb } from './db/client.ts';
import { Engine } from './engine/engine.ts';
import { createApp } from './http/app.ts';
import { initLogger } from './log.ts';
import { createDesktopSink } from './notify/notifier.ts';
import { CliT3Client } from './t3/CliT3Client.ts';
import { FakeT3Client } from './t3/FakeT3Client.ts';
import type { T3Client } from './t3/T3Client.ts';

function findWebDist(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../web/dist'), path.resolve(here, '../web/dist')];
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html'))) ?? null;
}

async function main() {
  const config = adoptPreRenameData(loadConfig());
  const log = initLogger(config.logsDir);
  log.info({ dataDir: config.dataDir, port: config.port, fakeT3: config.fakeT3 }, 'T3 Orchestra starting');

  const db = openDb(config.dbPath);
  let engine: Engine | null = null;
  const t3: T3Client = config.fakeT3
    ? new FakeT3Client({
        autoplay: true,
        gitDir: path.join(config.dataDir, 'fake-worktrees'),
        timeScale: Number(env('FAKE_SPEED') ?? 1) || 1,
      })
    : new CliT3Client({ t3Home: config.t3Home, cliPath: () => engine?.ctx.settings.get().t3CliPath ?? null });

  engine = new Engine({ db, t3, config, desktop: await createDesktopSink() });
  const webDistDir = config.isDev ? null : findWebDist();
  const app = createApp({ engine, port: config.port, webDistDir });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info(`T3 Orchestra listening on http://${config.host}:${info.port}`);
  });

  await engine.start();

  if (process.argv.includes('--open')) {
    const { default: open } = await import('open');
    void open(`http://127.0.0.1:${config.port}`).catch(() => undefined);
  }

  const shutdown = () => {
    log.info('shutting down');
    engine.stop();
    server.close();
    db.$client.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
