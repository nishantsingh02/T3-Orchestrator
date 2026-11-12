import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Finds the drizzle migrations folder in dev (src/db → ../../drizzle) and in the bundle (dist → ../drizzle). */
function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../drizzle'), path.resolve(here, '../drizzle')];
  const found = candidates.find((p) => fs.existsSync(path.join(p, 'meta', '_journal.json')));
  if (!found) throw new Error(`drizzle migrations not found (looked in ${candidates.join(', ')})`);
  return found;
}

/** Opens (creating if needed) and migrates the database. Pass ':memory:' for tests. */
export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema }) as Db;
  migrate(db, { migrationsFolder: migrationsFolder() });
  return db;
}
