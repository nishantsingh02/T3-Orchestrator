// End-to-end smoke test against a running server in fake-T3 mode (spec §18 "E2E smoke").
// Usage: T3ORCHESTRA_FAKE_T3=1 server running on :4417, then `tsx scripts/smoke.ts <scratch-repo-dir>`.
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

const base = process.env.T3ORCHESTRA_URL ?? 'http://127.0.0.1:4417';
const repo = path.resolve(process.argv[2] ?? 'smoke-repo');

async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-t3orchestra': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 120_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  if (!fs.existsSync(path.join(repo, '.git'))) {
    fs.mkdirSync(repo, { recursive: true });
    await execa('git', ['init', '-b', 'main', repo]);
    fs.writeFileSync(path.join(repo, 'README.md'), '# smoke\n');
    await execa('git', ['-C', repo, 'add', '.']);
    await execa('git', ['-C', repo, '-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '-m', 'init']);
  }
  const health = await api('GET', '/api/health');
  console.log('health', health);

  const v = await api('POST', '/api/validate-project', { projectPath: repo });
  console.log('validate', { ok: v.ok, base: v.baseBranch, errors: v.errors });

  const board = await api('POST', '/api/boards', { name: `Smoke ${Date.now().toString(36)}`, projectPath: repo, maxParallel: 2, mergeStrategy: 'local' });
  console.log('board', board.slug, board.short);

  // SSE: count events while the flow runs.
  const counts: Record<string, number> = {};
  const ctrl = new AbortController();
  void (async () => {
    const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const m of buf.matchAll(/^event: (\w+)$/gm)) counts[m[1]!] = (counts[m[1]!] ?? 0) + 1;
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    }
  })().catch(() => undefined);

  const plan = await api('POST', `/api/boards/${board.id}/plans`, { prompt: 'Build a tiny todo app\nwith tests', options: { maxTasks: 10, askQuestions: false } });
  console.log('plan', plan.id, plan.status);
  const ready = await until('plan ready', async () => {
    const p = await api('GET', `/api/plans/${plan.id}`);
    if (p.status === 'failed') throw new Error(`plan failed: ${p.error}`);
    return p.status === 'ready' ? p : null;
  });
  console.log('proposals', ready.proposals.map((t: any) => `${t.key}${t.dependsOn.length ? `←${t.dependsOn.join(',')}` : ''}`).join(' '));

  const accepted = await api('POST', `/api/plans/${plan.id}/accept`, {});
  console.log('accepted', accepted.tasks.map((t: any) => `#${t.number}:${t.stage}`).join(' '));

  await api('PATCH', `/api/boards/${board.id}`, { autoRun: true });
  const seenColumns = new Set<string>();
  const done = await until(
    'all tasks done',
    async () => {
      const tasks = await api<any[]>('GET', `/api/boards/${board.id}/tasks`);
      for (const t of tasks) seenColumns.add(t.column);
      const running = tasks.filter((t) => t.stage === 'implementing' || t.stage === 'ai_review').length;
      if (running > 2) throw new Error(`parallel limit exceeded: ${running}`);
      for (const t of tasks.filter((t) => t.stage === 'human_review')) {
        try {
          await api('POST', `/api/tasks/${t.id}/actions/approve`, {});
          console.log(`  approved #${t.number} (${t.stageReason})`);
        } catch (err) {
          console.log(`  approve #${t.number} failed: ${(err as Error).message.slice(0, 200)}`);
          if (String(err).includes('MERGE_CONFLICT')) await api('POST', `/api/tasks/${t.id}/actions/update-branch`, {});
        }
      }
      const failed = tasks.filter((t) => t.stage === 'failed');
      if (failed.length) throw new Error(`failed tasks: ${failed.map((t) => `#${t.number} ${t.stageReason}`).join(', ')}`);
      return tasks.every((t) => t.stage === 'done') ? tasks : null;
    },
    300_000,
  );
  ctrl.abort();
  const log = (await execa('git', ['-C', repo, 'log', '--oneline', '-12'])).stdout;
  console.log(`\nall ${done.length} tasks done; columns seen: ${[...seenColumns].join(', ')}`);
  console.log('SSE events:', counts);
  console.log('git log:\n' + log);
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
