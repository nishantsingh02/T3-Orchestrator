// Manual acceptance against REAL T3 (spec §19 M2/M5/M6): one trivial task through
// implement → AI review → human review → local merge. Costs two real agent runs.
// Usage: server running (not fake) on :4417, then `tsx scripts/real-check.ts <repo-known-to-T3>`.
import path from 'node:path';
import { execa } from 'execa';

const base = process.env.T3ORCHESTRA_URL ?? 'http://127.0.0.1:4417';
const repo = path.resolve(process.argv[2] ?? '.');

async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-t3orchestra': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

async function main() {
  const health = await api('GET', '/api/health');
  if (!health.serverReachable || health.fake) throw new Error(`need real, reachable T3: ${JSON.stringify(health)}`);
  const board = await api('POST', '/api/boards', { name: `Real check ${Date.now().toString(36)}`, projectPath: repo, skipReviewForTrivial: false, mergeStrategy: 'local' });
  console.log('board', board.slug, 'base', board.baseBranch);
  const task = await api('POST', `/api/boards/${board.id}/tasks`, {
    title: 'Add greeting file',
    description: 'Create `greeting.txt` at the repo root containing exactly the line `hello from t3orchestra`. Nothing else.',
    acceptanceCriteria: ['greeting.txt exists with the single line `hello from t3orchestra`', 'The change is committed on the task branch'],
    complexity: 'trivial',
  });
  const started = await api('POST', `/api/tasks/${task.id}/actions/start`, {});
  console.log('started', started.task.stage, started.task.branch, started.task.threadLink);

  const t0 = Date.now();
  let last = '';
  for (;;) {
    const t = await api('GET', `/api/tasks/${task.id}`);
    const line = `${t.column}${t.stageReason ? `(${t.stageReason})` : ''} run=${t.activeRun?.kind ?? '-'}/${t.activeRun?.status ?? '-'} thread=${t.lastThreadStatus}`;
    if (line !== last) console.log(`+${Math.round((Date.now() - t0) / 1000)}s ${line}`);
    last = line;
    if (t.stage === 'human_review') {
      console.log('summary:', t.lastSummary);
      console.log('findings:', t.findingsList.map((f: any) => `[${f.severity}] ${f.title}`));
      console.log('diffStat:', t.diffStat);
      break;
    }
    if (t.stage === 'failed') throw new Error(`task failed: ${t.stageReason} ${t.lastMessage}`);
    if (Date.now() - t0 > 15 * 60_000) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 3000));
  }
  const diff = await api('GET', `/api/tasks/${task.id}/diff?view=stat`);
  console.log('diff files:', diff.files, 'behindBy', diff.behindBy, 'uncommitted', diff.uncommitted);
  const approved = await api('POST', `/api/tasks/${task.id}/actions/approve`, {});
  console.log('approved →', approved.task.stage);
  console.log((await execa('git', ['-C', repo, 'log', '--oneline', '-3'])).stdout);
}

main().catch((err) => {
  console.error('REAL CHECK FAILED:', err);
  process.exit(1);
});
