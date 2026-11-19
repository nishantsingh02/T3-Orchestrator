# T3 Orchestra

T3 Orchestra is a local Kanban board for [T3 Code](https://t3.codes). You write one goal, a planner agent splits it into tasks, and each task runs as a T3 Code thread in its own git worktree. It tracks tasks through a board, runs an AI review and fix loop, tells you when an agent needs input, and ends with your review and merge.

T3 Orchestra does not run agents itself. It drives the `t3` CLI of a running T3 Code desktop app.

Status: early and experimental. Built and tested on Windows only. Not affiliated with T3 Code or its authors.

## What it does

- **Plan:** a planner agent turns one prompt into 3-40 tasks with dependencies and acceptance criteria.
- **Board:** tasks move through Backlog, Ready, Running, AI Review, Human Review and Done, plus Needs Input and Failed.
- **Run:** start tasks by hand or turn on Auto-run. The scheduler respects dependencies, a parallel limit, and file overlap.
- **Isolate:** each task gets its own branch and git worktree.
- **Review:** a separate AI reviewer checks each task. Blocking findings go back to the task agent for fix rounds.
- **Needs input:** when an agent asks a question, the card moves to Needs Input and you get a desktop notification. Answer in T3 and the card moves back.
- **Human review:** read the diff and findings, then merge locally, open a PR, request changes, or mark done.
- **Extras:** milestones/roadmap, project overview and insights, security audits and scans, a context knowledge graph, project run/preview, and a read-only MCP server.

## Requirements

- Node 22+ and pnpm 10
- git
- T3 Code desktop app running. T3 Orchestra talks to it through the `t3` CLI; on Windows that is `~/.t3/bin/t3.cmd`.

## Run locally

Install dependencies:

```sh
pnpm install
```

### Without real agents (recommended first)

```sh
pnpm dev:fake
```

Open http://localhost:5173. This uses a scripted fake T3 client. It creates real git worktrees and commits, but no real model runs. Its data is kept separately in `%APPDATA%\t3orchestra-fake` (or `~/.t3orchestra-fake`).

- A task title containing `ask` makes the fake agent wait for input.
- A title containing `blocked` makes it block.
- `T3ORCHESTRA_FAKE_SPEED=0.3` makes the fake faster.

### With real agents

Start the T3 Code desktop app first, then:

```sh
pnpm dev
```

The API runs on http://127.0.0.1:4417 and the UI on http://localhost:5173. Check http://127.0.0.1:4417/api/health: `serverReachable` must be `true` and `fake` must be `false`.

### Production build

```sh
pnpm build
pnpm start
```

This serves the API and web app on http://127.0.0.1:4417 and opens the browser.

## Tests

```sh
pnpm test
pnpm typecheck
```

The tests use the fake T3 client, temporary git repos, and HTTP guards, so no real agents are needed.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `T3ORCHESTRA_HOME` | `%APPDATA%\t3orchestra` / `~/.t3orchestra` | Data directory: `t3orchestra.sqlite`, `logs/`, prompt overrides |
| `T3ORCHESTRA_PORT` | `4417` | HTTP port (binds 127.0.0.1 only) |
| `T3ORCHESTRA_FAKE_T3` | unset | `1` uses the fake T3 client |
| `T3CODE_HOME` | `~/.t3` | Where to find `bin/t3.cmd` and `userdata/server-runtime.json` |
| `T3ORCHESTRA_LOG_LEVEL` | `info` | Log level |

Prompt templates are in `apps/server/prompts/*.md` (Mustache). Copy one into `<dataDir>/prompts/` to override it.

## Project layout

```
apps/server       Node + Hono API, SQLite (Drizzle), T3 CLI adapter, task engine
apps/web          Vite + React UI
packages/shared   Shared contracts, enums, transitions and view types
docs/             API and T3 CLI notes
```

## License

MIT
