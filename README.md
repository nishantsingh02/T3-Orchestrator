# T3 Orchestra

A local Kanban companion for [T3 Code](https://t3.codes). It turns one large prompt into a board of tasks, runs each
task as a T3 Code thread in its own git worktree, adds an automatic AI review → fix loop, alerts you when an agent
needs input, and finishes with a human review and merge. The full spec is in [`SPEC.md`](SPEC.md).

T3 Orchestra never runs agents itself: everything goes through the `t3` CLI of a running T3 Code app.

> **Status:** early and experimental. Built and tested on Windows only; the macOS and Linux code paths exist but
> haven't been run. This is an independent project, not affiliated with T3 Code or its authors.

![The board: tasks move from Backlog through Running, Needs Input and AI Review to Human Review and Done](docs/screenshots/board.png)

## Requirements

- Node 22+ and pnpm 10
- git
- T3 Code desktop app running (the CLI talks to it). On Windows the CLI launcher is `~/.t3/bin/t3.cmd`.

## Quick start

```sh
pnpm install
pnpm dev              # server on :4417 (node --watch) + Vite on :5173 → open http://localhost:5173
```

The server's dev script uses `node --watch --import tsx`, not `tsx watch`: on Windows, `tsx watch` reads
stdin, and under `concurrently` that pipe is shared with the server, which then hangs at startup until a key is
pressed ("Can't reach the T3 Orchestra server").

Without real agents (UI work, demos): `pnpm dev:fake`. This uses a scripted `FakeT3Client` that plays short agent
timelines, creates real git worktrees and commits, and keeps its data apart (`%APPDATA%\t3orchestra-fake`).
Titles containing "ask" make the fake agent wait for input; titles containing "blocked" make it block.
`T3ORCHESTRA_FAKE_SPEED=0.3` speeds the fake up.

Production:

```sh
pnpm build            # web → apps/web/dist, server → apps/server/dist
pnpm start            # serves the API and the web app on http://127.0.0.1:4417 and opens the browser
```

## Screenshots

From a demo project on `pnpm dev:fake`.

**A plan to review before anything runs**: tasks with milestones, dependencies and the paths each one touches.

![Plan review: the proposed tasks with milestone, category, complexity, priority, dependencies and paths](docs/screenshots/plan.png)

**Roadmap**: milestones in the order auto-run works through them, each with its progress and a finish estimate.

![Roadmap: three milestones with progress bars and their tasks](docs/screenshots/roadmap.png)

**Overview**: where the board stands, the pace, what holds work back and what needs you.

![Overview: progress by column, pace, scope, tasks done per day, blocked tasks and what needs you](docs/screenshots/overview.png)

## Using it

1. **New board**: pick one of T3 Code's projects (**From T3 Code**, most recently active first) or type a repo path
   (**Folder path**; it must be a git repo known to T3, and the form offers "Add to T3"), and a base branch.
   When T3 already has threads for the project, **Learn about the project from its T3 threads** (on by default)
   starts an import as the board is created: T3 Orchestra collects the threads (titles for all, the first ask, latest
   ask and last reply for the 25 most relevant: the ones still open in T3's sidebar first, then the newest; sub-agent
   threads and T3 Orchestra's own review threads left out), and a read-only agent on the root checkout reads them and
   the code. Its **project context** (what the project is, the stack and layout, how to run it, what is done, what
   is half-done, open decisions, next steps) goes into the board brief, so every planner, coding and review agent on
   the board starts from it. A banner shows the import while it runs; when it's done, **View** shows what it wrote
   and **Plan next steps** opens the plan composer with its next steps. Board settings has **Import again** (also
   for older boards), which replaces the earlier context in the brief and keeps the rest.
2. **New plan** (in the board's **Plans** view, or press `P`): write the big prompt. A planner thread reads the repo
   and proposes 3–40 tasks with dependencies. Edit the table, refine, then accept. Tasks land in Ready (or Backlog).
   The Plans view lists every plan with the tasks it created and where they stand.
3. **Run**: press Start on a card, or turn on **Auto-run**. The scheduler starts Ready tasks whose dependencies are
   Done, within the parallel limit, avoiding tasks that touch the same paths.
4. Each finished implementation gets a **separate AI reviewer thread**. Blocking findings go back to the task
   thread for up to `maxFixRounds` fix rounds.
5. **Needs Input**: when an agent asks something, the card moves to Needs Input and you get a desktop toast.
   Answer in T3 (Open in T3); the card moves back on its own.
6. **Human review**: read the diff and findings, then Approve & merge (local `git merge --no-ff` into the base
   branch of your root checkout), open a PR, request changes, or mark done.
   The AI reviewer also scores each task 1–10 for how much it needs your review. With **Auto-approve tasks** set
   in the board settings, tasks that pass AI review with a score under your limit are approved without you, the
   same way Approve would, so the tasks that depend on them can start.
7. **Run project**: the Run button in the board toolbar starts the project (the root checkout) and gives you its
   link; the same button in a task's drawer runs that task's worktree, so you can try a branch before merging.
   T3 Orchestra reads the files to pick the way: package.json scripts and the framework (Vite, Next.js, Electron…),
   Django/FastAPI/Flask/Streamlit, Jupyter, Cargo, Go, .NET, Maven/Gradle, CMake, Makefile `run`, loose C/C++
   sources, Rails, PHP, Deno, Flutter, Godot, plain HTML (served by T3 Orchestra), Docker Compose. A frontend and an
   API in separate folders start together. Web apps show their output and the localhost URL; console programs
   open in their own window. "Change how it runs" lists the alternatives and takes your own command, which
   can be saved per board. Compiled output goes to `<dataDir>/run-builds/`, not into the repo. If the command
   only starts the app and exits (say, it starts Docker containers), the run stays live while the app answers,
   and Stop runs the project's own stop command (a `stop` script, `docker compose down`).
   When a run fails, **Fix with AI** hands the error and the output to an agent: a task's own agent for a
   worktree run, or a new task (started at once) for the board's run, so the fix is reviewed and merged as usual.
8. **Overview** (the switch next to the board name, or `/b/<board>/overview`): progress by column, what's left
   and a rough finish estimate at the recent pace, scope per plan (planned tasks vs. follow-ups added since), tasks
   done and added per day, why Backlog/Ready tasks aren't running (the same reasons the cards show), which
   unfinished tasks unblock the most, what needs you, and where the time went (agent time per kind of run, time
   waiting in Human Review or for your answer, merge conflicts at approve).
9. **Roadmap** (`/b/<board>/roadmap`): **milestones** (M1, M2…) are phases that each end in something that works.
   The planner groups a plan's tasks into milestones, and accepting the plan creates them (or adds to one with the
   same title). You can also add, edit, reorder and delete them by hand and move tasks between them (the task's ⋮
   menu, the drawer, or New task). Auto-run starts tasks of earlier milestones first, then tasks without one.
   The **Suggestions** inbox lists every follow-up the agents suggested that you haven't added or dismissed,
   grouped by task: add them (one or many, into a milestone; they land where accepted plan tasks land) or
   dismiss them (with undo). **Plan next milestone** opens the plan composer with where each milestone stands,
   the open tasks without one, and the unpicked suggestions.
10. **Insights** (`/b/<board>/insights`): ask questions about the project ("What is the architecture?", "Any
   security concerns?") and get answers from an agent that reads the root checkout and changes nothing. Each
   chat is one T3 thread (Open in T3 shows it there); the agent also knows the board's brief, milestones and
   open tasks, so it doesn't suggest what is already planned. While it works you see its messages so far;
   follow-up questions continue the same thread. When the agent carries on after its turn (its background
   sub-agents came back and T3 resumed the thread), the answer reopens and fills in; questions you type in
   T3 itself show up in the chat too. **Plan from this** opens the plan composer with an answer, to turn
   its suggestions into tasks. Chats can be renamed and deleted (the T3 thread stays).
   With `pnpm dev:fake`, a question containing "wait for me" makes the fake agent wait for you in T3, and
   one containing "background" ends its turn early and then goes on by itself.
11. **Security** (`/b/<board>/security`): where the project stands and what to fix first.
   - **Audits**: an agent reads the root checkout as an attacker would (it changes nothing) and reports what
     it can exploit, each with the file and line, the code as evidence, how it is reached and how to fix it.
     Audit the whole project, only the commits since the last audit, or some paths, optionally narrowed to
     areas (auth, injection, web, secrets, data, crypto, dependencies, infrastructure, AI and agents, abuse).
     Each audit's report has its conclusion, the attack surface and what it checked and found fine. The next
     audit re-checks the open findings and closes the ones that are fixed.
   - **Secret scan** (local, no agent): API keys and tokens, private keys, passwords in connection strings,
     hard-coded secrets and committed `.env` files, in the tracked files and the last 300 commits. Only a short
     preview and a hash of each secret are kept.
   - **Dependency scan**: reads the lockfiles (npm, pnpm, Yarn, Bun, pip, Poetry, uv, Cargo, Go, Bundler,
     Composer, NuGet, Pub, Gradle, Mix) and checks the installed versions against OSV.dev, which gets package
     names and versions only. One finding per vulnerable package, with the version that fixes every advisory.
   - **Findings** (S-1, S-2…) from all three: **Add to board** makes a Backlog task with the evidence and the
     fix; dismiss one as a false positive, an accepted risk or won't fix (with a note audits read); mark it
     fixed. A later scan or audit that no longer sees it marks it fixed; one that sees it again reopens it.
   - **Settings**: a security context audits read (who uses the app, what it protects), **Security checks in
     AI reviews** (every task's reviewer also looks for security issues; those findings are listed here), and
     **Scan automatically** (both scans again when the checkout moves to a new commit, at least daily).
   - **Report** downloads a Markdown report of the open findings, what is being fixed, accepted risks and the
     latest audit. The tab shows how many critical and high findings are open.
   With `pnpm dev:fake`, the fake auditor reports three findings (new ones each round) and closes the first
   earlier finding it is asked to re-check.
12. **Context** (`/b/<board>/context`): files that give the board's agents context, and the **knowledge graph**
   built from them.
   - **Files**: drop specs, briefs, meeting notes, PDFs, Word/Excel files, images or code anywhere on the view
     (up to 100 MB each, the most GitHub takes; 300 per board), or **Write a note**, saved as a Markdown
     file. A file uploaded again under the same name replaces the old one.
   - **In the project**: the files are kept in the project at `.t3orchestra/context/files/`, with the graph beside
     them in `.t3orchestra/context/graph.json` (files named, not by id). Commit the folder and the context goes
     wherever the project goes: a board made for the project on another computer (or after a clone or pull)
     loads the files, their state and the graph from it, and starts no build for files already in the graph.
     The folder wins: files added, changed or deleted in it by hand count as uploads and removals, and a
     `graph.json` written elsewhere replaces the board's graph. T3 Orchestra never commits it for you; the footer of
     the file list says whether it is committed. Uncommitted changes in it don't block a merge, and a
     `graph.json` that can't be read (a merge conflict) is left alone until it can.
   - **Builds**: a read-only agent on the root checkout reads the new or changed files and turns them into
     nodes (requirements, decisions, constraints, features, components, data, integrations, actors, terms,
     open questions), each with its sources (file, page or section, a quote) and the code paths where it
     lives, linked by relations ("constrains", "depends on"…). It flags files that contradict each other or the
     code as open questions, and rewrites the overview of everything the files say. A build starts after each
     upload (**Read new files right away**, on by default) or with **Read N new files**; big uploads go in
     batches of 12 files, one build after the other. **Rebuild from scratch** reads every file again.
     Removing a file takes what only it said out of the graph at once.
   - **The graph**: drag to pan, scroll to zoom, click a node for its summary, sources, code and links; filter
     by type with the chips, search by name, or focus one file's nodes from the file list.
   - **How agents use it**: with **Use in agent prompts** on (the default), every planner, coding agent,
     reviewer, Insights chat, Ideas and Marketing generation, security audit and import gets a "Project
     knowledge" section: the overview, the nodes that match its task (by the words they share, rarer words
     counting more, and by the paths the task touches) with their links, and where the files are so it can
     open them. **What agents see** shows that section for any text you type. Agents with the MCP tools below
     can also look things up with `context_search`. Templates you overrode in `<dataDir>/prompts/` need a
     `{{knowledge}}` line to get it.
   With `pnpm dev:fake`, the fake agent makes a node per file and per heading of each text file.

## Ask T3 Code about a board (MCP)

The server is also a read-only MCP server at `http://127.0.0.1:4417/mcp`, so you can ask any T3 Code chat
"what is my-app working on?" or "show me my-app's progress". Register it once for Claude:

```sh
claude mcp add --transport http --scope user t3orchestra http://127.0.0.1:4417/mcp
```

New threads then have five tools: `list_boards`; `board_status` (done of total, the running tasks with each
agent's latest message, what needs you, what starts next and why the rest waits, milestones, pace and a finish
estimate); `board_card` (the same as an HTML card that T3 Code shows inline through `html_render`);
`task_details` (one task by number: description, criteria, latest agent message, findings, runs, events); and
`context_search` (the board's knowledge graph: matching nodes with their sources, code paths and links, or an
outline of the whole graph with no query).
The board argument takes a name, slug or id, and can be left out with only one board. The board server has to be
running; nothing on the board can be changed through MCP.

## Configuration

| Env var | Default | |
|---|---|---|
| `T3ORCHESTRA_HOME` | `%APPDATA%\t3orchestra` / `~/.t3orchestra` | data dir: `t3orchestra.sqlite`, `logs/`, `prompts/` overrides |
| `T3ORCHESTRA_PORT` | `4417` | HTTP port (binds 127.0.0.1 only) |
| `T3ORCHESTRA_FAKE_T3` | unset | `1` = fake T3 |
| `T3CODE_HOME` | `~/.t3` | where to find `bin/t3.cmd` and `userdata/server-runtime.json` |
| `T3ORCHESTRA_LOG_LEVEL` | `info` | pino level |

Prompt templates live in `apps/server/prompts/*.md` (Mustache). Copy one into `<dataDir>/prompts/` to override it.

## Layout

```
apps/server     Node + Hono API, SQLite (Drizzle), T3 CLI adapter, engine (transitions, reconciler, scheduler)
apps/web        Vite + React UI
packages/shared zod contracts, enums, columnFor(), the transition table, view types
docs/           api.md (REST/SSE contract), t3-cli-notes.md (verified CLI behaviour)
```

Key rules: only `transition()` (apps/server/src/engine/transitions.ts) changes a task's stage, every change writes an
`events` row, and agents only report through a fenced ```` ```t3orchestra-result ```` JSON block.

## Scripts

- `pnpm test`: vitest (shared logic, engine timelines on the fake T3, git helpers on temp repos, HTTP guards)
- `pnpm typecheck`
- `pnpm --filter @t3-orchestra/server spike <scratch-repo>`: re-verifies the real CLI's behaviour (see docs/t3-cli-notes.md)
- `tsx apps/server/scripts/smoke.ts <scratch-repo>`: end-to-end flow against a running fake-mode server
- `tsx apps/server/scripts/real-check.ts <repo>`: one real task through implement → review → merge (real agents)

## Security notes

Localhost only, Host-header check (DNS rebinding), `X-T3Orchestra: 1` on every mutating request (CSRF), no shell
interpolation (the Windows launcher spawns the T3 exe directly; prompts always go through stdin). Threads started
through the CLI use T3's default runtime mode for the project, which may be `full-access`; the board settings show it.
Run project is the exception to "no shell": it runs the detected or saved command through the system shell in the
project folder, as you would in a terminal, so only run projects you trust.
`/mcp` needs no `X-T3Orchestra` header (MCP clients can't send one); it only reads, takes `application/json` posts only,
and refuses browsers from other origins.

## License

[MIT](LICENSE)
