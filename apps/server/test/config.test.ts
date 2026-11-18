import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptPreRenameData, loadConfig } from '../src/config.ts';

describe('data from before the rename', () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
  });

  function dirs() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't3orchestra-config-'));
    tmps.push(tmp);
    const legacy = path.join(tmp, 't3-board');
    fs.mkdirSync(path.join(legacy, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 't3board.sqlite'), 'db');
    fs.writeFileSync(path.join(legacy, 'prompts', 'review.md'), 'mine');
    return { legacy, config: loadConfig({ dataDir: path.join(tmp, 't3orchestra'), fakeT3: false }) };
  }

  it('moves the old folder into place and renames the database', () => {
    const { legacy, config } = dirs();
    const out = adoptPreRenameData(config, legacy);
    expect(out).toEqual(config);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(config.dataDir, 't3orchestra.sqlite'), 'utf8')).toBe('db');
    expect(fs.readFileSync(path.join(config.promptsOverrideDir, 'review.md'), 'utf8')).toBe('mine');
  });

  it('keeps the old database name while its write-ahead log is there', () => {
    const { legacy, config } = dirs();
    fs.writeFileSync(path.join(legacy, 't3board.sqlite-wal'), 'log');
    const out = adoptPreRenameData(config, legacy);
    expect(out.dataDir).toBe(config.dataDir);
    expect(out.dbPath).toBe(path.join(config.dataDir, 't3board.sqlite'));
  });

  it('leaves the old folder alone once the new one exists', () => {
    const { legacy, config } = dirs();
    fs.mkdirSync(config.dataDir);
    expect(adoptPreRenameData(config, legacy)).toEqual(config);
    expect(fs.existsSync(path.join(legacy, 't3board.sqlite'))).toBe(true);
  });
});
