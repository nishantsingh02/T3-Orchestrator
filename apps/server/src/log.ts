import fs from 'node:fs';
import path from 'node:path';
import { pino, type Logger } from 'pino';
import { env } from './config.ts';

export type { Logger };

let root: Logger = pino({ level: env('LOG_LEVEL') ?? 'silent' });

/** Logs to stdout and to `<logsDir>/t3orchestra.log` (spec §19 M8). */
export function initLogger(logsDir: string | null, level = env('LOG_LEVEL') ?? 'info'): Logger {
  const streams: pino.StreamEntry[] = [{ level: level as pino.Level, stream: process.stdout }];
  if (logsDir) {
    fs.mkdirSync(logsDir, { recursive: true });
    streams.push({ level: level as pino.Level, stream: pino.destination({ dest: path.join(logsDir, 't3orchestra.log'), sync: false }) });
  }
  root = pino({ level }, pino.multistream(streams));
  return root;
}

export function log(): Logger {
  return root;
}

export function childLog(name: string): Logger {
  return root.child({ mod: name });
}
