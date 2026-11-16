// Read-only check of the import's inputs against the real T3: lists T3's projects and builds the
// thread digest an import of each named project would send (prints sizes; starts no agent).
// Usage: node --import tsx scripts/import-digest-check.ts <project title>... [--print]
import os from 'node:os';
import path from 'node:path';
import { indexLine, pickThreads, threadDigest } from '../src/engine/imports.ts';
import { CliT3Client } from '../src/t3/CliT3Client.ts';

const t3 = new CliT3Client({ t3Home: process.env.T3CODE_HOME ?? path.join(os.homedir(), '.t3') });
const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const print = process.argv.includes('--print');

const started = Date.now();
const projects = await t3.listProjects();
console.log(`${projects.length} projects in ${Date.now() - started} ms; most recent: ${projects.slice(0, 5).map((p) => `${p.title} (${p.threadCount})`).join(', ')}`);

for (const name of names) {
  const p = projects.find((x) => x.title === name);
  if (!p) {
    console.log(`no project "${name}"`);
    continue;
  }
  const t0 = Date.now();
  const picked = pickThreads(await t3.list(p.id));
  const read = [];
  for (const s of picked.detail) {
    const { thread, messages } = await t3.show(s.threadId, { messages: 30 });
    read.push({ summary: s, detail: thread, messages });
  }
  const details = read.map((t) => threadDigest(t, 'main')).join('\n\n');
  const index = picked.index.map(indexLine).join('\n');
  console.log(
    `${name}: ${picked.total} threads (of ${p.threadCount}), ${read.length} read, ${picked.index.length} indexed; ` +
      `digest ${details.length} + index ${index.length} chars; collected in ${Date.now() - t0} ms`,
  );
  if (print) console.log(`${details.slice(0, 3000)}\n…\n${index.slice(0, 800)}`);
}
