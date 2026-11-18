// MCP endpoint (Streamable HTTP, stateless, read-only): lets agents in T3 Code answer "what is board X working
// on and how far along is it". Plain JSON-RPC over POST /mcp: every request gets one JSON answer, no sessions,
// no server-sent stream.
import type { Context } from 'hono';
import { z } from 'zod';
import { listBoards } from '../engine/boards.ts';
import { AppError, type EngineContext } from '../engine/context.ts';
import { searchKnowledge } from '../knowledge/service.ts';
import { childLog } from '../log.ts';
import { errorMessage } from '../util.ts';
import { boardReport, boardsMarkdown, findTask, resolveBoard, statusHtml, statusMarkdown, taskMarkdown } from './report.ts';

const log = childLog('mcp');

/** Newest first; an unknown client version gets the newest. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `T3 Orchestra runs T3 Code agents on a Kanban board: each task is a T3 thread in its own worktree, with an AI review and a human review before it merges.
Use board_status to answer what a board is working on, what needs the user and how far along it is; board_card for a visual of the same (in T3 Code, show it with html_preview, then html_render); task_details for one task (#number); context_search for what the user's context files say (requirements, decisions, constraints…). With one board, the board argument can be left out. Everything here is read-only: to change a board, point the user to the board link.`;

type Content = Array<{ type: 'text'; text: string }>;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  args: z.ZodType;
  run(ctx: EngineContext, args: never): Promise<Content>;
}

const boardProp = { type: 'string', description: 'Board name, slug or id. Leave out when there is only one board.' };

const TOOLS: Tool[] = [
  {
    name: 'list_boards',
    title: 'List boards',
    description: 'Every T3 Orchestra board with its project folder and progress: tasks done, running, needing the user, auto-run on or off.',
    inputSchema: { type: 'object', properties: {} },
    args: z.object({}),
    run: async (ctx) => [{ type: 'text', text: boardsMarkdown(listBoards(ctx)) }],
  },
  {
    name: 'board_status',
    title: 'Board status',
    description:
      "What a board is working on right now and how far along it is: tasks done of total, the running tasks with each agent's latest message, " +
      'what needs the user (questions, failures, reviews), what starts next and why the rest waits, milestone progress, pace and a rough finish estimate.',
    inputSchema: {
      type: 'object',
      properties: {
        board: boardProp,
        agentMessages: { type: 'boolean', description: "Include each live agent's latest message (asks T3 Code, about a second). Default true." },
      },
    },
    args: z.object({ board: z.string().optional(), agentMessages: z.boolean().optional() }),
    run: async (ctx, a: { board?: string; agentMessages?: boolean }) => {
      const r = await boardReport(ctx, a.board, { agentNotes: a.agentMessages ?? true });
      return [{ type: 'text', text: statusMarkdown(r) }];
    },
  },
  {
    name: 'board_card',
    title: 'Board progress card',
    description:
      'The board status as a self-contained HTML card (progress bar by column, running tasks, what needs the user, up next, milestones) styled with T3 Code\'s theme variables. ' +
      'In T3 Code, pass the HTML unchanged to html_preview, then to html_render with the contentHeight it reports.',
    inputSchema: { type: 'object', properties: { board: boardProp } },
    args: z.object({ board: z.string().optional() }),
    run: async (ctx, a: { board?: string }) => {
      const r = await boardReport(ctx, a.board, { agentNotes: true });
      return [
        { type: 'text', text: `HTML card for ${r.board.name} follows (${r.overview.done} of ${r.overview.total} done). Board: ${r.url}/overview` },
        { type: 'text', text: statusHtml(r) },
      ];
    },
  },
  {
    name: 'task_details',
    title: 'Task details',
    description:
      "One task on a board: stage, description, acceptance criteria, the agent's latest message, branch, diff size, open review findings, runs and recent events.",
    inputSchema: {
      type: 'object',
      properties: { board: boardProp, task: { type: ['integer', 'string'], description: 'Task number, e.g. 54 or "#54".' } },
      required: ['task'],
    },
    args: z.object({ board: z.string().optional(), task: z.union([z.number().int(), z.string()]) }),
    run: async (ctx, a: { board?: string; task: number | string }) => {
      const board = resolveBoard(ctx, a.board);
      return [{ type: 'text', text: await taskMarkdown(ctx, board, findTask(ctx, board, a.task)) }];
    },
  },
  {
    name: 'context_search',
    title: 'Search project knowledge',
    description:
      "Looks up the board's knowledge graph, built from the files the user added on the board's Context page (specs, notes, documents): " +
      'requirements, decisions, constraints, features, components, data, integrations, people and terms, each with its sources, ' +
      'the code paths where it lives and how it links to the rest. Leave the query out for an outline of everything in it.',
    inputSchema: {
      type: 'object',
      properties: {
        board: boardProp,
        query: { type: 'string', description: 'What to look up, e.g. "refunds" or "who can delete accounts".' },
        limit: { type: 'integer', description: 'Most nodes to return (default 10).' },
      },
    },
    args: z.object({ board: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
    run: async (ctx, a: { board?: string; query?: string; limit?: number }) => {
      const board = resolveBoard(ctx, a.board);
      return [{ type: 'text', text: searchKnowledge(ctx, board.id, a.query ?? '', a.limit) }];
    },
  },
];

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type JsonRpcId = string | number | null;
type JsonRpcReply = { jsonrpc: '2.0'; id: JsonRpcId } & ({ result: unknown } | { error: { code: number; message: string } });

const rpcError = (id: JsonRpcId, code: number, message: string): JsonRpcReply => ({ jsonrpc: '2.0', id, error: { code, message } });

async function callTool(ctx: EngineContext, params: Record<string, unknown>) {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
  const parsed = tool.args.safeParse(params.arguments ?? {});
  if (!parsed.success) throw new RpcError(-32602, parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '));
  try {
    return { content: await tool.run(ctx, parsed.data as never) };
  } catch (err) {
    // Board and task lookups the agent can fix ("no board X") come back as tool errors it can read.
    if (err instanceof AppError) return { content: [{ type: 'text', text: err.message }], isError: true };
    throw err;
  }
}

async function handle(ctx: EngineContext, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 't3orchestra', title: 'T3 Orchestra', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: true, openWorldHint: false },
        })),
      };
    case 'tools/call':
      return callTool(ctx, params);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/** One JSON-RPC message → its reply; null for notifications and for the client's own replies. */
async function dispatch(ctx: EngineContext, msg: unknown): Promise<JsonRpcReply | null> {
  if (typeof msg !== 'object' || msg === null) return rpcError(null, -32600, 'Invalid request');
  const m = msg as { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };
  if (typeof m.method !== 'string') return 'result' in m || 'error' in m ? null : rpcError(m.id ?? null, -32600, 'Invalid request');
  if (m.id === undefined) return null;
  const params = typeof m.params === 'object' && m.params !== null ? (m.params as Record<string, unknown>) : {};
  try {
    return { jsonrpc: '2.0', id: m.id, result: await handle(ctx, m.method, params) };
  } catch (err) {
    if (err instanceof RpcError) return rpcError(m.id, err.code, err.message);
    log.error({ err, method: m.method }, 'mcp request failed');
    return rpcError(m.id, -32603, errorMessage(err));
  }
}

/** Browsers send Origin; MCP clients don't. Only the board's own pages may (spec: validate Origin). */
function localOrigin(origin: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export async function handleMcp(c: Context, ctx: EngineContext): Promise<Response> {
  const origin = c.req.header('origin');
  if (origin && !localOrigin(origin)) return c.text('Forbidden origin', 403);
  // JSON only: a form or text/plain post from another site never gets this far.
  if (!(c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
    return c.text('Content-Type must be application/json', 415);
  }
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.json(rpcError(null, -32700, 'Parse error'), 400);
  }
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map((m) => dispatch(ctx, m)))).filter((r) => r !== null);
  if (replies.length === 0) return c.body(null, 202);
  return c.json(Array.isArray(body) ? replies : replies[0]);
}
