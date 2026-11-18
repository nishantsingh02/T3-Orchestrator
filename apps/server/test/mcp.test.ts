import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.ts';
import { runAction } from '../src/engine/actions.ts';
import { createMilestone } from '../src/engine/milestones.ts';
import { setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(() => h?.cleanup());

const PORT = 4417;

function mcp() {
  const app = createApp({ engine: h.engine, port: PORT });
  let id = 0;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('/mcp', {
      method: 'POST',
      headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    });
  const rpc = async (method: string, params?: unknown) => {
    const res = await post({ jsonrpc: '2.0', id: ++id, method, params });
    expect(res.status).toBe(200);
    return (await res.json()) as { result?: any; error?: { code: number; message: string } };
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const { result } = await rpc('tools/call', { name, arguments: args });
    return { text: (result.content as Array<{ text: string }>).map((c) => c.text).join('\n'), isError: result.isError === true, content: result.content };
  };
  return { app, post, rpc, tool };
}

describe('MCP endpoint', () => {
  it('speaks MCP: initialize, notifications, tools/list, unknown methods', async () => {
    h = await setup();
    const { post, rpc } = mcp();
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 't3orchestra' } });
    expect((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-11-25');

    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);

    const list = await rpc('tools/list');
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['list_boards', 'board_status', 'board_card', 'task_details', 'context_search']);
    expect(list.result.tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint)).toBe(true);

    expect((await rpc('resources/list')).error?.code).toBe(-32601);
    expect((await rpc('tools/call', { name: 'nope' })).error?.code).toBe(-32602);
    expect((await rpc('tools/call', { name: 'task_details', arguments: {} })).error?.code).toBe(-32602);
  });

  it('refuses browsers from other sites, non-JSON posts and GET', async () => {
    h = await setup();
    const { app, post } = mcp();
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await post(ping, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(ping, { origin: `http://localhost:5173` })).status).toBe(200);
    expect((await post(ping, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(ping, { host: 'evil.example:4417' })).status).toBe(403);
    expect((await app.request('/mcp', { headers: { host: `127.0.0.1:${PORT}` } })).status).toBe(405);
  });

  it('reports what a board is working on, what needs the user and what is next', async () => {
    h = await setup();
    const ctx = h.ctx;
    const m1 = createMilestone(ctx, h.board.id, { title: 'Walking skeleton', goal: 'It runs' });
    const running = h.newTask({ title: 'Build the API', milestoneId: m1.id });
    const asking = h.newTask({ title: 'Pick a database' });
    const waiting = h.newTask({ title: 'Write the docs', dependsOn: [running.id] });
    for (const t of [running, asking, waiting]) await runAction(ctx, t.id, 'move-to-ready', {});
    await runAction(ctx, running.id, 'start', {});
    await runAction(ctx, asking.id, 'start', {});
    h.fake.say(h.openRun(running.id)!.threadId!, 'Wiring the routes now.');
    const askThread = h.openRun(asking.id)!.threadId!;
    h.fake.say(askThread, 'Postgres or SQLite?');
    h.fake.setStatus(askThread, 'waiting', { pendingRequestCount: 1 });
    await h.tick();
    expect(h.view(asking.id).column).toBe('needs_input');

    const { tool } = mcp();
    expect((await tool('list_boards')).text).toContain('**Test Board**');

    const status = (await tool('board_status')).text;
    expect(status).toContain('# Test Board: 0 of 3 tasks done (0%)');
    expect(status).toMatch(/## Working on now \(1\)\n- \*\*#1 Build the API\*\* \(M1\): implementing/);
    expect(status).toContain('Latest from the agent: "Wiring the routes now."');
    expect(status).toContain('**#2 Pick a database** [Needs Input]: waits for you');
    expect(status).toContain('The agent says: "Postgres or SQLite?"');
    expect(status).toContain('- #3 Write the docs: waits for #1');
    expect(status).toContain('- M1 · Walking skeleton: 0 of 1 done, 1 in progress');

    const card = await tool('board_card', { board: 'test' });
    expect(card.content).toHaveLength(2);
    expect(card.content[1].text).toMatch(/^<!doctype html>/);
    expect(card.content[1].text).toContain('Build the API');

    const detail = (await tool('task_details', { task: '#1' })).text;
    expect(detail).toContain('# #1 Build the API');
    expect(detail).toContain('## Latest from the agent\nWiring the routes now.');
  });

  it('answers lookups it cannot resolve as tool errors the agent can read', async () => {
    h = await setup();
    const { tool } = mcp();
    expect(await tool('board_status', { board: 'nope' })).toMatchObject({ isError: true, text: 'No board "nope". Boards: Test Board.' });
    expect(await tool('task_details', { task: 99 })).toMatchObject({ isError: true, text: 'Test Board has no task #99.' });
  });
});
