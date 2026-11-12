// M0 spike (spec §4.5, §19): exercises the real t3 CLI end to end and records what it returns.
// Usage: pnpm --filter @t3-orchestra/server spike <scratch-repo-dir> [out.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { CliT3Client } from '../src/t3/CliT3Client.ts';
import { extractResultBlock } from '../src/engine/results.ts';

const repo = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 't3orchestra-spike-repo'));
const outFile = process.argv[3] ? path.resolve(process.argv[3]) : path.join(repo, '..', 't3orchestra-spike.json');
const t3Home = process.env.T3CODE_HOME ?? path.join(os.homedir(), '.t3');
const client = new CliT3Client({ t3Home });
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), repo };
const save = () => fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

async function git(...args: string[]) {
  return (await execa('git', ['-C', repo, ...args])).stdout;
}

async function waitFinished(threadId: string, label: string, baseline: string | null) {
  const seen: Array<{ t: number; status: string; latestRunId: string | null; pending: number; items: number }> = [];
  const t0 = Date.now();
  for (;;) {
    const { thread, messages } = await client.show(threadId, { messages: 10 });
    const last = seen.at(-1);
    if (!last || last.status !== thread.status || last.latestRunId !== thread.latestRunId || last.pending !== thread.pendingRequestCount) {
      seen.push({ t: Date.now() - t0, status: thread.status, latestRunId: thread.latestRunId, pending: thread.pendingRequestCount, items: thread.itemCount });
      console.log(`[${label}] +${Date.now() - t0}ms status=${thread.status} run=${thread.latestRunId} pending=${thread.pendingRequestCount}`);
    }
    const started = thread.latestRunId !== baseline;
    if (started && !['preparing', 'queued', 'starting', 'running'].includes(thread.status)) {
      return { seen, thread, messages };
    }
    if (Date.now() - t0 > 10 * 60_000) throw new Error(`${label}: timed out waiting`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  report.health = await client.health();
  console.log('health', report.health);
  report.launcher = client.getLauncher();

  if (!fs.existsSync(path.join(repo, '.git'))) {
    fs.mkdirSync(repo, { recursive: true });
    await execa('git', ['init', '-b', 'main', repo]);
    fs.writeFileSync(path.join(repo, 'README.md'), '# t3orchestra spike repo\n');
    await git('add', '.');
    await git('-c', 'user.name=t3orchestra', '-c', 'user.email=t3orchestra@localhost', 'commit', '-m', 'init');
  }

  try {
    await client.list(repo);
    report.projectKnown = true;
  } catch (err) {
    report.projectKnown = false;
    report.listError = String(err);
    console.log('adding project to T3…');
    report.addProjectOut = await client.execRaw(['project', 'add', repo]).catch((e) => `ERR ${e}`);
  }

  // 1) plain thread in the project root
  const prompt1 = [
    'This is an automated integration check. Do not edit any files.',
    'Reply with one short sentence, then end your message with exactly this block:',
    '```t3orchestra-result',
    '{ "status": "done", "summary": "spike ok" }',
    '```',
  ].join('\n');
  const startRaw = await client.execRaw(['thread', 'start', '--json', '--title', 'T3 Orchestra spike [tb spik-1]', repo, '-'], prompt1);
  report.startRaw = startRaw;
  console.log('start raw:', startRaw);
  const start = JSON.parse(startRaw);
  const threadId: string = start.threadId ?? start.thread?.threadId ?? start.id;
  report.threadId = threadId;
  const run1 = await waitFinished(threadId, 'run1', null);
  report.run1 = { seen: run1.seen, thread: run1.thread, messages: run1.messages };
  report.run1Result = extractResultBlock(run1.messages.filter((m) => m.role === 'assistant').map((m) => m.text));
  save();

  // 2) send a follow-up
  const baseline = run1.thread.latestRunId;
  const sendRaw = await client.execRaw(
    ['thread', 'send', '--json', threadId, '-'],
    'Second check. Do not edit files. End with:\n```t3orchestra-result\n{ "status": "done", "summary": "send ok" }\n```',
  );
  report.sendRaw = sendRaw;
  console.log('send raw:', sendRaw);
  const run2 = await waitFinished(threadId, 'run2', baseline);
  report.run2 = { seen: run2.seen, thread: run2.thread, messages: run2.messages };
  save();

  // 3) worktree thread that commits a file
  const branch = `t3orchestra/spike/1-hello-${Date.now().toString(36)}`;
  const wtPrompt = [
    'Automated integration check. Create a file named hello.txt containing the single line "hi",',
    'commit it with message "#1: add hello" and leave no uncommitted changes. Do nothing else.',
    'End your final message with:',
    '```t3orchestra-result',
    '{ "status": "done", "summary": "added hello.txt" }',
    '```',
  ].join('\n');
  const wtRaw = await client.execRaw(
    ['thread', 'start', '--json', '--title', '#1 Spike worktree [tb spik-2]', '--worktree', 'main', '--branch', branch, repo, '-'],
    wtPrompt,
  );
  report.worktreeStartRaw = wtRaw;
  const wt = JSON.parse(wtRaw);
  const wtId: string = wt.threadId ?? wt.thread?.threadId ?? wt.id;
  const run3 = await waitFinished(wtId, 'run3', null);
  report.run3 = { seen: run3.seen, thread: run3.thread, messages: run3.messages };
  if (run3.thread.worktreePath) {
    report.run3Git = {
      log: (await execa('git', ['-C', run3.thread.worktreePath, 'log', '--oneline', '-3'])).stdout,
      status: (await execa('git', ['-C', run3.thread.worktreePath, 'status', '--porcelain'])).stdout,
      branch: (await execa('git', ['-C', run3.thread.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout,
    };
  }

  report.listAfter = await client.list(repo);
  report.finishedAt = new Date().toISOString();
  save();
  console.log(`\nreport written to ${outFile}`);
}

main().catch((err) => {
  report.error = String(err?.stack ?? err);
  save();
  console.error(err);
  process.exit(1);
});
