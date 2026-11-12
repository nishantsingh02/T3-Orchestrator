// T3 Code's WebSocket RPC (`/ws`, the API its own web app uses), for what the CLI cannot do:
// settle threads, read the provider/model list and list projects. Not a public contract (see
// docs/t3-cli-notes.md), so keep this small.
import { randomUUID } from 'node:crypto';

/** `/ws` answers 426 to clients without this protocol version. */
const ORCHESTRATION_PROTOCOL = '2';
const NOT_FOUND_RE = /no orchestration projection exists|not found/i;

export interface ThreadCommandResult {
  threadId: string;
  ok: boolean;
  notFound: boolean;
  error?: string;
}

interface RpcRequest {
  tag: string;
  payload: unknown;
}

/**
 * Sends the requests over one connection and returns each one's `exit` (Effect RPC), in order.
 * Throws only when the connection itself fails.
 */
async function rpc(o: { origin: string; token: string; requests: RpcRequest[]; timeoutMs?: number }): Promise<unknown[]> {
  if (!o.requests.length) return [];
  const url = new URL('/ws', o.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('orchestrationProtocol', ORCHESTRATION_PROTOCOL);
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${o.token}` } });
  const pending = new Set(o.requests.map((_, i) => String(i + 1)));
  const exits = new Map<string, unknown>();

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`T3 did not answer ${pending.size} request(s) in time`)), o.timeoutMs ?? 15_000);
      const done = (err?: Error) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      ws.addEventListener('open', () => {
        o.requests.forEach((r, i) => ws.send(JSON.stringify({ _tag: 'Request', id: String(i + 1), tag: r.tag, payload: r.payload, headers: [] })));
      });
      ws.addEventListener('message', (e) => {
        let msgs: unknown[];
        try {
          msgs = [JSON.parse(String(e.data))].flat();
        } catch {
          return;
        }
        for (const m of msgs as Array<Record<string, unknown>>) {
          if (m._tag !== 'Exit' || typeof m.requestId !== 'string' || !pending.delete(m.requestId)) continue;
          exits.set(m.requestId, m.exit);
        }
        if (pending.size === 0) done();
      });
      ws.addEventListener('error', () => done(new Error(`could not connect to T3 Code at ${url.origin}/ws`)));
      ws.addEventListener('close', (e) => done(new Error(`T3 Code closed the connection (${e.code}${e.reason ? `: ${e.reason}` : ''})`)));
    });
  } finally {
    ws.close();
  }
  return o.requests.map((_, i) => exits.get(String(i + 1)));
}

/**
 * Dispatches one orchestration command (e.g. `thread.settle`) per thread over a single connection.
 * Throws only when the connection itself fails; per-thread failures come back as results.
 */
export async function dispatchThreadCommands(o: {
  origin: string;
  token: string;
  type: 'thread.settle';
  threadIds: string[];
  timeoutMs?: number;
}): Promise<ThreadCommandResult[]> {
  const exits = await rpc({
    origin: o.origin,
    token: o.token,
    timeoutMs: o.timeoutMs,
    requests: o.threadIds.map((threadId) => ({ tag: 'orchestration.dispatchCommand', payload: { type: o.type, commandId: randomUUID(), threadId } })),
  });
  return o.threadIds.map((threadId, i) => {
    const error = exitError(exits[i]);
    return error === null ? { threadId, ok: true, notFound: false } : { threadId, ok: false, notFound: NOT_FOUND_RE.test(error), error };
  });
}

/** `server.getConfig` (needs `orchestration:read`): providers, their models, and T3's settings. */
export async function getServerConfig(o: { origin: string; token: string; timeoutMs?: number }): Promise<unknown> {
  const [exit] = await rpc({ ...o, requests: [{ tag: 'server.getConfig', payload: {} }] });
  const error = exitError(exit);
  if (error !== null) throw new Error(`T3 server.getConfig failed: ${error}`);
  return (exit as { value?: unknown }).value;
}

/**
 * The shell snapshot (projects and thread summaries, needs `orchestration:read`): the first item of the
 * `orchestration.subscribeShell` stream. The subscription is interrupted as soon as it arrives.
 */
export async function getShellSnapshot(o: { origin: string; token: string; timeoutMs?: number }): Promise<unknown> {
  const url = new URL('/ws', o.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('orchestrationProtocol', ORCHESTRATION_PROTOCOL);
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${o.token}` } });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('T3 did not send its project list in time')), o.timeoutMs ?? 20_000);
      const done = (err: Error | null, value?: unknown) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'orchestration.subscribeShell', payload: {}, headers: [] }));
      });
      ws.addEventListener('message', (e) => {
        let msgs: Array<Record<string, unknown>>;
        try {
          msgs = [JSON.parse(String(e.data))].flat();
        } catch {
          return;
        }
        for (const m of msgs) {
          if (m.requestId !== '1') continue;
          if (m._tag === 'Exit') return done(new Error(`T3 orchestration.subscribeShell failed: ${exitError(m.exit) ?? 'the stream ended early'}`));
          if (m._tag !== 'Chunk' || !Array.isArray(m.values)) continue;
          const item = (m.values as Array<{ kind?: string; snapshot?: unknown }>).find((v) => v?.kind === 'snapshot');
          if (item) {
            ws.send(JSON.stringify({ _tag: 'Interrupt', requestId: '1' }));
            return done(null, item.snapshot);
          }
        }
      });
      ws.addEventListener('error', () => done(new Error(`could not connect to T3 Code at ${url.origin}/ws`)));
      ws.addEventListener('close', (e) => done(new Error(`T3 Code closed the connection (${e.code}${e.reason ? `: ${e.reason}` : ''})`)));
    });
  } finally {
    ws.close();
  }
}

/** Null for a successful exit, else its error message. */
function exitError(exit: unknown): string | null {
  const x = (exit ?? {}) as { _tag?: string; cause?: unknown };
  if (x._tag === 'Success') return null;
  const causes = (Array.isArray(x.cause) ? x.cause : [x.cause]) as Array<{ error?: { message?: unknown }; defect?: unknown } | undefined>;
  return causes.map((c) => (typeof c?.error?.message === 'string' ? c.error.message : c?.defect !== undefined ? String(c.defect) : null)).find(Boolean) ?? 'command failed';
}
