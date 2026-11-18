# T3 Orchestra: Product & Technical Spec (v1)

> **Working name:** T3 Orchestra, a Kanban companion app for T3 Code
> **Status:** Draft for implementation
> **Date:** 2026-11-05
> **Stack:** Vite + React (web UI), Node + TypeScript backend, SQLite, driving T3 Code through the `t3` CLI

---

## 1. Summary

T3 Orchestra is a local web app that turns one large prompt into a board of tasks and runs each one as a T3 Code thread in its own git worktree. It tracks every task live through a Kanban board, adds an automatic AI review step, alerts you when an agent needs input, and finishes with a human review and merge.

T3 Code already does the heavy work: agent sessions, providers and models, worktrees, PR linking, and the question and approval UI. T3 Orchestra adds what T3 lacks:

- a **task backlog** (tasks that exist before any thread does),
- a **planner** that splits a big goal into dependent tasks,
- a **scheduler** that starts tasks by hand or automatically, within a parallel limit and in dependency order,
- an **AI review → fix loop** before you look at anything,
- one **board** showing everything that is running, waiting, failed or ready for review,
- **notifications** when something needs you.

### Flow at a glance

```
Big prompt ──► Planner thread ──► Proposed tasks ──► (you edit & accept)
                                                           │
                       ┌───────────────────────────────────┘
                       ▼
   Backlog ──► Ready ──► Running ──► AI Review ──► Human Review ──► Done
                  ▲          │  ▲         │   │          │
                  │          │  └─ fix ◄──┘   │          ├─► request changes ─► Running
                  │          ▼                │          └─► merge conflict ──► Running (update branch)
                  │     Needs Input ◄─────────┘
                  │     (agent asked you something → notification)
                  └── scheduler auto-starts when deps are Done and a slot is free
   Failed (visible column) ◄── run failed / interrupted / agent blocked
```

---

## 2. Goals and non-goals

### Goals (v1)
1. **Plan from one prompt:** a planner thread proposes 3–40 tasks with dependencies, acceptance criteria, complexity and the code areas each one touches.
2. **Review the plan:** you edit, remove or add tasks before accepting, or ask the planner to refine the plan.
3. **Kanban board** with live status that needs no refresh.
4. **Start tasks manually, or let them start on their own** (auto-run), within a parallel limit and in dependency order.
5. **Isolation:** each task gets its own T3 thread in its own git worktree and branch.
6. **AI review loop:** a separate reviewer thread checks each finished task, and its findings go back to the task's thread for a fix, for up to N rounds.
7. **Needs-input detection:** when an agent asks a question or waits for an approval, the card moves to *Needs Input* and you get a desktop notification.
8. **Human review:** see the diff and the AI findings, then request changes, merge locally, open a PR, mark done or discard.
9. **Crash-safe:** all state lives in SQLite, the backend can restart mid-run and catch up, and the scheduler runs in the backend, not the UI.

### Non-goals (v1)
- Running agents directly. All agent work goes through T3 Code.
- Answering T3 questions and approvals inside T3 Orchestra. In v1 you jump to the thread in T3; see §21 for the later plan.
- Multiple users, auth or cloud hosting. It runs on localhost only.
- GitHub issue import, ideation, roadmap and changelog (see §20, *Later*).
- Splitting tasks into subtasks with their own sub-schedule. The agent manages that inside its thread.

---

## 3. Glossary

| Term | Meaning |
|---|---|
| **T3 project** | A repo registered in T3 Code. Every board points to one. |
| **Thread** | A T3 Code agent session. It has a status, runs, messages, and optionally a worktree and branch. |
| **Run** | One agent turn inside a thread, started by a `start` or `send`. T3 gives each run an ID (`run:thread:<id>:ordinal:<n>`). |
| **Board** | A Kanban board in T3 Orchestra, bound to one T3 project and a base branch. |
| **Plan** | One big prompt plus a planner thread plus the proposed tasks (with versions). |
| **Task** | One card. It owns at most one *task thread* (implementation) and creates separate *review threads*. |
| **Stage** | The app's own lifecycle state for a task (§6). Only the backend changes it. |
| **Attention** | A derived flag: the task's active thread is waiting for a human. |
| **Slot** | A unit of the parallel limit. Each task in `implementing` or `ai_review` uses one. |

---

## 4. T3 Code integration surface (verified on this machine)

### 4.1 Environment facts
- **T3 Code version:** `0.1.8-nightly.20261104.4165` (desktop app, nightly channel).
- **CLI launcher:** `~/.t3/bin/t3.cmd`. It runs `T3 Code (Nightly).exe` with `ELECTRON_RUN_AS_NODE=1` and `resources\server.asar\apps\server\dist\bin.mjs`.
- **Server runtime info:** `~/.t3/userdata/server-runtime.json` holds `{ pid, host, port: 3773, origin: "http://127.0.0.1:3773", serverVersion }`.
- **CLI speed:** `t3 thread list --json` took **~0.67s** wall time. Polling every 2–3s is fine; polling every 200ms is not.
- The CLI talks to the **running** T3 server. If T3 isn't running, CLI calls fail, and the board must show that clearly (§15).

### 4.2 CLI commands used

```
t3 thread start [flags] <project> <message>
    <project>  project id OR a path inside the project (e.g. the repo root)
    <message>  the prompt, or "-" to read it from stdin  ← ALWAYS use stdin
    --title <s>         thread title (default: first line of message)
    --provider <id>     provider instance id (pass together with --model)
    --model <slug>      model slug (default: the project's default model)
    --worktree <ref>    run in a NEW git worktree based on this branch/tag/commit
    --branch <name>     branch name for the new worktree
    --wait              block until done; exit 1 = run failed, 2 = waiting for an answer
    --json              JSON output

t3 thread send [flags] <thread> <message>
    A busy thread receives it as its next turn; nothing is interrupted.
    --wait, --json as above

t3 thread show [flags] <thread>
    --messages <n>  latest N messages
    --json

t3 thread list [flags]
    --project <id-or-path>  (default: cwd)
    --json

t3 project add|remove|rename   (there is no "list" subcommand)
t3 auth session issue --scope ... --ttl ... --label ... --token-only   (for the future WS adapter)
```

**The CLI cannot:** interrupt or cancel a thread, set runtime mode or interaction (plan) mode, answer a pending question or approval, or archive a thread. Those need the T3 UI, or the WebSocket adapter later (§20).

### 4.3 `t3 thread show --json` shape (observed)

```json
{
  "thread": {
    "threadId": "0f9de509-…",
    "projectId": "43e834b5-…",
    "title": "…",
    "link": "https://app.t3.codes/threads/<envId>/<threadId>",
    "createdBy": "user",
    "creationSource": "web",
    "status": "running",
    "latestRunId": "run:thread:<threadId>:ordinal:4",
    "activeRunId": "run:thread:<threadId>:ordinal:4",
    "providerInstanceId": "claudeAgent",
    "model": "claude-opus-5-5",
    "runtimeMode": "full-access",
    "interactionMode": "default",
    "linkedPullRequest": null,
    "pullRequests": [],
    "branch": null,
    "worktreePath": "C:\\…",
    "parentThreadId": null,
    "relationshipToParent": null,
    "runCount": 4,
    "itemCount": 43,
    "pendingRequestCount": 0,
    "archived": false,
    "settled": false,
    "snoozed": false,
    "createdAt": "2026-11-05T02:05:21.244Z",
    "updatedAt": "2026-11-05T02:41:05.040Z"
  },
  "messages": [
    { "role": "assistant", "runId": "run:thread:<threadId>:ordinal:4", "text": "…" }
  ]
}
```

`t3 thread list --json` returns an array of the same thread summaries, without `messages`, `activeRunId`, `branch`, `worktreePath` or `pendingRequestCount`, so use `show` for those.

### 4.4 Thread status values

From T3's thread-list filter: `idle, preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled, rolled_back`.

| Group | Statuses | Meaning for T3 Orchestra |
|---|---|---|
| **Active** | `preparing`, `queued`, `starting`, `running` | Agent is working |
| **Attention** | `waiting`, or `pendingRequestCount > 0` | Needs a human: a question or an approval |
| **Finished OK** | `completed` (and `idle` with `runCount > 0`) | Run ended normally; parse the result |
| **Finished badly** | `failed`, `interrupted`, `cancelled`, `rolled_back` | Run did not complete |

### 4.5 Things to check in milestone M0 (spikes)
1. The exact JSON shape of `thread start --json` and `thread send --json`. Do they include `threadId`, `runId` and `link`?
2. Whether `thread list` paginates or caps results.
3. What `thread send` does to a thread with a **pending question**: answer it or queue? Assume it queues.
4. Which runtime mode and permissions CLI-started threads get. The CLI can't set them, so they're probably the project or app defaults.
5. Whether a finished run always ends in `completed`, or sometimes `idle`.
6. Whether T3-launched Claude sessions load the repo's `.mcp.json` (needed later for the progress tool).
7. Whether `pullRequests[]` items include a state (open or merged), so PR mode can mark tasks done automatically.

Record the answers in `docs/t3-cli-notes.md` and keep the adapter consistent with them.

---

## 5. User workflows

### 5.1 Create a board
1. Click **New board** and enter a name, the **project path** (repo root), the **base branch** (default: the current branch of the root checkout) and the defaults: auto-run off, max parallel 3, AI review on, merge strategy (§13).
2. The backend checks that:
   - the path exists and is a git repo (`git -C <path> rev-parse --show-toplevel`),
   - the base branch exists,
   - T3 knows the project (`t3 thread list --project <path> --json` succeeds). If not, it shows **"Add to T3"**, which runs `t3 project add <path>`, then checks again.
3. The board is created with an empty backlog.

### 5.2 Plan from a big prompt
1. Click **New plan** to open the composer. It has a large markdown textarea and options:
   - planner model (default: the board default),
   - max tasks (default 20, max 40),
   - "Ask clarifying questions before planning" (default on),
   - extra planner guidance (optional).
2. Submitting creates a **Plan** (status `planning`) and starts a **planner thread** in the project root (no worktree; the planner only reads). The prompt goes in through stdin (template in §9.2).
3. The plan screen shows:
   - live status: *Planning…*, *Needs your input* (with an *Open in T3* button), *Ready for review* or *Failed*,
   - a link to the planner thread.
4. If the planner asks a question, the plan goes to `needs_input` and you get a notification. You answer in T3 and the reconciler picks up the change.
5. When the planner run finishes, the backend reads the result block (§9.1) and checks it against the schema (§9.2).
   - **Invalid:** the backend automatically sends **one** correction message with the validation errors. If the result is still invalid, the plan becomes `failed` and the raw output is shown, with buttons to retry or discard.
   - **Valid:** a new `plan_version` is stored and the plan status becomes `ready`.

### 5.3 Review and accept a plan
1. The plan review screen shows:
   - the summary, assumptions and open questions,
   - an **editable table** of proposed tasks (title, description, acceptance criteria, complexity, category, priority, dependencies, touches),
   - a **dependency view**: tasks grouped into "waves" by topological depth.
2. Checks run live:
   - no dependency cycles,
   - every dependency points to an existing key,
   - titles are not empty,
   - no more than the max task count.
3. Actions:
   - **Refine plan** sends free-text feedback to the planner thread. That makes a new run and a new version, and the diff against the previous version is highlighted.
   - **Accept all / Accept selected** creates tasks numbered `#n` and turns `dependsOn` keys into task-to-task links. Tasks go into **Ready** or **Backlog**, depending on the board's `acceptInto` setting.
   - **Discard plan**.
4. On accept, the plan summary is appended to the board's **brief**, a markdown doc included in every implementation prompt as shared context.

### 5.4 Run tasks
- **Manual:** a Backlog or Ready card's **Start** button starts it right away.
  - If dependencies aren't done: a confirmation dialog, *"#4 depends on #2 (In Review). Start anyway?"*.
  - Manual starts **ignore the parallel limit**, but the header shows something like *"4/3 running"*.
- **Auto-run on:** the scheduler (§7) starts Ready tasks whose dependencies are all **Done**, in order of priority, then position, then number, until the slots are full.
- **Starting a task:**
  - creates its branch `t3orchestra/<boardSlug>/<num>-<slug>` from the base branch,
  - starts a T3 thread in a **new worktree** on that branch, titled `#<num> <title> [tb <boardShort>-<num>]` (the bracketed marker makes retries safe; see §15.3),
  - moves the task to `implementing`.

### 5.5 The agent needs input
- When the reconciler sees the active thread `waiting` (or `pendingRequestCount > 0`), it sets `attention` on the task, and the card moves to **Needs Input**. This applies to the implement, fix and review stages.
- A desktop notification goes out: *"#7 Add OAuth callback needs your input"*. Clicking it opens the task in T3 Orchestra.
- The card and the task drawer show **Open in T3** (the thread's `link`). In v1 you answer in T3.
- When the thread becomes active again, `attention` clears and the card returns to its stage column.

### 5.6 AI review loop
1. When the implement run finishes with `status: "done"`, the task moves to `ai_review`, unless AI review is off for the board or the task, or the task is `trivial` and `skipReviewForTrivial` is on.
2. A **new reviewer thread** starts in the project root, with no worktree. The reviewer reads the task's worktree with `git -C <worktreePath> …` and must not edit anything. It may run tests and linters there. (Template in §9.4.)
3. The reviewer returns `{ verdict, summary, findings[] }`.
   - **`pass`**, or no findings at or above the board's `reviewStrictness`: the task goes to `human_review` with reason `ai_passed`.
   - **`changes_requested` and `fixRound < maxFixRounds`** (default 2): the findings are sent to the **task thread** (fix template, §9.5), `fixRound` goes up by one, and the task goes back to `implementing`. When that run finishes, the review repeats.
   - **`changes_requested` with no rounds left:** the task goes to `human_review` with reason `ai_unresolved`. The findings stay attached and the badge shows the count, e.g. "2 major unresolved".
   - **Reviewer run fails:** the task goes to `human_review` with reason `review_failed` and a **Re-run AI review** button.

### 5.7 Human review
The drawer opens on the **Review** tab:
- the **result summary** from the implementer (what changed, tests run, follow-ups),
- **AI findings** by severity, each marked addressed, open or dismissed,
- a **diff viewer**: file list with `+/-` stats, a unified diff with a side-by-side toggle, and a warning if there are uncommitted changes,
- a **"behind base by N commits"** indicator.

Actions:
- **Request changes:** your text goes to the task thread, the task returns to `implementing`, `fixRound` resets to 0, and AI review runs again after.
- **Approve & merge:** follows the board's merge strategy (§13).
- **Open PR** (PR strategy): asks the task thread to push and open a PR. The PR link appears on the card from `thread.pullRequests`.
- **Mark done:** for when you merged it yourself.
- **Discard:** the task becomes `discarded`. The branch and worktree are left alone, with a hint to clean up in T3.
- **Send message:** free text to the task thread; a follow-up run that goes through `implementing` and then AI review again.

### 5.8 Failure and retry
- A task becomes `failed` when its run ends `failed`, `interrupted`, `cancelled` or `rolled_back`, when the agent returns `status: "blocked"`, or when its thread disappears.
- The **Failed** column (shown only when it has cards) lists the reason and the agent's last message.
- Actions:
  - **Resume:** sends the resume template plus an optional note to the same thread.
  - **Retry fresh:** a new thread and worktree with a fresh branch suffix `-r2`; the old branch is kept.
  - **Edit & retry:** opens the task editor first.
  - **Discard.**

### 5.9 One-off tasks
**New task** creates a task by hand: title, description, acceptance criteria, dependencies, complexity, model override. It goes into Backlog.

---

## 6. Task lifecycle

### 6.1 Stages (stored, changed only by the backend)

| Stage | Description |
|---|---|
| `backlog` | Accepted but not eligible for auto-start |
| `ready` | Eligible; the scheduler starts it when dependencies are Done and a slot is free |
| `implementing` | A task-thread run (implement, fix, changes, resume, rebase, follow-up or PR) is the current step |
| `ai_review` | A reviewer-thread run is the current step |
| `human_review` | Waiting for you |
| `done` | Merged or marked done |
| `failed` | Needs a decision |
| `discarded` | Hidden (shown only with the "Show discarded" filter) |

Draft (proposed) tasks live in `plan_versions` and aren't `tasks` rows until you accept them.

`stageReason` (string, nullable) gives more detail, for example:
- **human_review:** `ai_passed`, `ai_unresolved`, `review_failed`, `ai_review_skipped`, `merge_conflict`
- **failed:** `run_failed`, `run_interrupted`, `run_cancelled`, `agent_blocked`, `thread_missing`, `start_failed`

### 6.2 Columns (derived; one pure function in `packages/shared`)

```ts
function columnFor(task: TaskView): Column {
  if (task.stage === 'discarded') return 'hidden';
  if (task.attention) return 'needs_input';               // overrides stage columns
  switch (task.stage) {
    case 'backlog':      return 'backlog';
    case 'ready':        return 'ready';
    case 'implementing': return 'running';
    case 'ai_review':    return 'ai_review';
    case 'human_review': return 'human_review';
    case 'done':         return 'done';
    case 'failed':       return 'failed';
  }
}
```

Column order: **Backlog · Ready · Running · Needs Input · AI Review · Human Review · Done · Failed** (Failed only when it has cards; Done can be collapsed).

### 6.3 Transition table (the only place stages change)

All transitions go through `transition(taskId, event)` in one SQLite transaction. It checks the current stage. A transition that isn't allowed is logged as an `illegal_transition` event and **ignored**, never thrown to the UI.

| Event | From | To | Side effects |
|---|---|---|---|
| `plan.accepted` | (none) | `ready` / `backlog` | create task rows and dependency links |
| `user.move_to_ready` | `backlog` | `ready` | |
| `user.move_to_backlog` | `ready` | `backlog` | |
| `user.start` / `scheduler.start` | `backlog`, `ready` | `implementing` | start task thread (implement run) |
| `run.done` (implement/fix/changes/resume/rebase/followup) | `implementing` | `ai_review` | start reviewer thread (round = reviewRound+1) |
| same, AI review skipped | `implementing` | `human_review` (`ai_review_skipped`) | |
| `run.blocked` | `implementing` | `failed` (`agent_blocked`) | store the agent's explanation |
| `run.failed` / `interrupted` / `cancelled` | `implementing` | `failed` (`run_*`) | |
| `review.pass` | `ai_review` | `human_review` (`ai_passed`) | store findings |
| `review.changes` & rounds left | `ai_review` | `implementing` | send fix message; `fixRound++` |
| `review.changes` & no rounds | `ai_review` | `human_review` (`ai_unresolved`) | |
| `review.failed` | `ai_review` | `human_review` (`review_failed`) | |
| `user.rerun_review` | `human_review` | `ai_review` | new reviewer thread |
| `user.request_changes` | `human_review` | `implementing` | send changes message; `fixRound = 0` |
| `user.send_message` | `human_review`, `failed` | `implementing` | follow-up run |
| `user.approve` (merge OK) | `human_review` | `done` | local merge done |
| `user.approve` (conflict) | `human_review` | `human_review` (`merge_conflict`) | `git merge --abort`; offer *Update branch* |
| `user.update_branch` | `human_review` | `implementing` | send rebase message |
| `user.open_pr` | `human_review` | `implementing` | send PR message; after the run, back to `human_review` with no re-review |
| `user.mark_done` | `human_review` | `done` | |
| `pr.merged` (later) | `human_review` | `done` | |
| `user.resume` | `failed` | `implementing` | resume message on the same thread |
| `user.retry_fresh` | `failed` | `implementing` | new thread, worktree and branch |
| `user.discard` | any but `implementing`, `ai_review` | `discarded` | |
| `thread.missing` | `implementing`, `ai_review` | `failed` (`thread_missing`) | |

**Attention** is not a stage. The reconciler sets it to `'question' | 'approval' | 'waiting' | null` from the active run's thread, whenever the task is `implementing` or `ai_review`.

**Rules that always hold:**
- A task has at most **one active run** at a time.
- Only the backend changes `stage`. Clients send *actions*, not stages.
- Every stage change writes an `events` row.
- Agents never write to T3 Orchestra's data. They only *report* through result blocks, which the backend checks and applies.

### 6.4 Progress display
Each card shows a **pipeline strip** instead of a fake percentage:

`● Plan  ● Build  ◐ AI review (r2)  ○ Human  ○ Done`

- Filled means done, half means current (animated while the thread is active), empty means not reached.
- Below the strip: `Running · 6m · 41 events`, where events is `itemCount` growth since the run began, as a sign of activity.
- If `updatedAt` hasn't changed for more than `staleAfterMinutes` (default 15) while the run is active, the card shows a grey **"quiet for 18m"** hint. It is information only and never auto-fails the task.

---

## 7. Scheduler

It runs in the backend after every reconcile tick and right after any task event.

```
for board in boards where board.autoRun and t3Healthy:
    active      = tasks(board) where stage in (implementing, ai_review)
    slotsBoard  = board.maxParallel - count(active)
    slotsGlobal = settings.globalMaxParallel - count(active across all boards)
    slots = min(slotsBoard, slotsGlobal)
    if slots <= 0: continue

    candidates = tasks(board) where stage == ready
                   and all(dep.stage == done for dep in deps)
                   and not overlapsActive(task.touches, active.touches)   // if board.avoidOverlap
    order candidates by priority(high>medium>low), position asc, number asc
    for task in candidates.take(slots):
        startImplementRun(task)           // transition user/scheduler.start
```

- **`overlapsActive`:** two tasks overlap if any `touches` entry of one is a path prefix of an entry in the other. For example, `src/auth/` overlaps `src/auth/login.ts`. An empty `touches` never overlaps. This cuts down on merge conflicts cheaply.
- **Dependency gate:** in v1 a dependency counts only when it is **`done`**, meaning merged into the base branch, so a dependent task's worktree is created from a base that already has its dependencies' changes.
- **Blocked dependencies:** if a dependency is `failed` or `discarded`, the dependent card shows a red **"blocked by #3 (failed)"** chip and won't auto-start.
- **Pause:** the board's **Auto-run** toggle, plus a global **Pause all** in the header. Pausing never stops running threads; it only stops new ones from starting.
- **Health gate:** if the T3 health check fails, the scheduler starts nothing and the header shows a banner.

---

## 8. Reconciler (status sync)

It is a single loop in the backend. Ticks never overlap.

**Interval:** `pollActiveMs` (default 2000) while any run is active or waiting, otherwise `pollIdleMs` (default 15000).

Each tick, for every board with tracked threads:
1. Run `t3 thread list --project <projectPath> --json`, **one call per board**.
2. For each tracked thread (any run in `starting`, `active` or `waiting`):
   - Find it in the list output. If it's missing, run `t3 thread show <id> --json`. If `show` errors with not-found, apply `thread.missing`.
   - If `status` or `updatedAt` changed since the last tick, run `t3 thread show <id> --messages 5 --json` to get `pendingRequestCount`, `activeRunId`, `worktreePath`, `branch` and messages.
3. **Work out the run's state:**
   - Every run row stores a `baselineRunId`: the thread's `latestRunId` just *before* the start or send, or null for a new thread. It also stores `t3RunId` when the CLI returns it.
   - The run has **started** when `latestRunId !== baselineRunId`, or `latestRunId === t3RunId`.
   - The run has **finished** when it has started and the thread status is in a finished group (§4.4).
   - **Attention** means status `waiting` or `pendingRequestCount > 0`.
4. **When a run finishes:**
   - Take the assistant messages whose `runId` equals the finished run's ID. If the CLI only gives the latest N messages, ask for more until all of that run's messages are in.
   - Extract the **last** `t3orchestra-result` block (§9.1), check it with zod, and store `resultRaw` and `resultJson`.
   - Send the matching event (`run.done`, `run.blocked`, `run.failed`, `review.pass`, `review.changes` and so on) to `transition()`.
   - If the result block is missing or invalid:
     - **Implement-type runs:** treat as `run.done` with `resultMissing = true`. The reviewer still checks the work, and the card shows "no structured result".
     - **Review runs:** treat as `review.failed`.
     - **Plan runs:** send the correction message once (§5.2).
5. **Update cached fields:** `lastThreadStatus`, `attention`, `lastActivityAt`, `worktreePath`, `branch`, `prUrl` (from `linkedPullRequest` or `pullRequests[0]`), `itemCount`.
6. **Send** SSE events for every changed task or plan, and notifications (§12).

**Runs started outside the app:** if you chat with a task thread directly in T3, new runs appear that T3 Orchestra didn't start.
- While the task is in `implementing`: any finished run counts (the last result block wins).
- While it is in `human_review`, `done` or `failed`: the stage doesn't change, but the card shows **"agent activity since review"** and the diff is re-read.

**Startup:** the reconciler runs at once on boot, before the scheduler, and matches orphan threads by their title marker (§15.3).

---

## 9. Agent prompts and output contracts

Prompt templates live in `apps/server/prompts/*.md` and use Mustache-style `{{vars}}`. Users can override them in `<dataDir>/prompts/*.md`, which takes priority. Every prompt ends with the **result contract**.

### 9.1 The result block

Agents end their final message with exactly one fenced block whose language tag is `t3orchestra-result`:

````
```t3orchestra-result
{ "status": "done", "summary": "…" }
```
````

The parser finds the **last** block with this tag in the run's assistant messages, runs `JSON.parse`, then the zod schema for that run kind. The language tag avoids clashing with ordinary code blocks.

### 9.2 Planner

**Template `planner.md`:**

````text
You are the planning agent for T3 Orchestra. Your job: turn the GOAL below into a set of
independent, well-scoped implementation tasks for coding agents. Each task will be
executed by a separate agent in its own git worktree, branched from `{{baseBranch}}`,
and merged back before dependent tasks start.

## Rules
- Do NOT edit, create, or delete files. Read the codebase to ground the plan.
- {{#askQuestions}}If the goal is ambiguous in ways that change the plan, ask the user
  concise clarifying questions BEFORE planning (use your question tool).{{/askQuestions}}
- Size each task so one agent can finish it in one focused session
  (roughly < 400 changed lines). Split bigger work.
- Prefer tasks that can run in parallel. Only add a dependency when a task truly needs
  another task's code merged first.
- Every task must be verifiable: give concrete acceptance criteria.
- List the paths/areas each task will likely touch in `touches` (directories or files,
  repo-relative, forward slashes). Tasks that touch the same area should usually be
  sequential (dependency) or merged into one task.
- If the project needs scaffolding first, make that task #1 and have others depend on it.
- Max {{maxTasks}} tasks.

## Board context
{{boardBrief}}

## GOAL
{{prompt}}

{{#extraGuidance}}## Extra guidance
{{extraGuidance}}{{/extraGuidance}}

## Output
End your final message with exactly one block:

```t3orchestra-result
{
  "summary": "2-5 sentence overview of the approach",
  "assumptions": ["…"],
  "openQuestions": ["… (non-blocking questions for the user)"],
  "tasks": [
    {
      "key": "T1",
      "title": "Imperative, < 70 chars",
      "description": "Markdown. What to build and why, key decisions, pointers to relevant files.",
      "acceptanceCriteria": ["Observable, testable statements"],
      "complexity": "trivial | small | medium | large",
      "category": "feature | bug | refactor | test | docs | infra | design",
      "priority": "high | medium | low",
      "dependsOn": ["T0"],
      "touches": ["src/auth/", "src/routes/login.tsx"]
    }
  ]
}
```
````

**Schema (zod, `packages/shared/src/contracts.ts`):**
```ts
const PlanTask = z.object({
  key: z.string().regex(/^T\d+$/),
  title: z.string().min(3).max(120),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  complexity: z.enum(['trivial','small','medium','large']),
  category: z.enum(['feature','bug','refactor','test','docs','infra','design']),
  priority: z.enum(['high','medium','low']).default('medium'),
  dependsOn: z.array(z.string()).default([]),
  touches: z.array(z.string()).default([]),
});
const PlanResult = z.object({
  summary: z.string(),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  tasks: z.array(PlanTask).min(1).max(40),
}).superRefine(noUnknownDeps).superRefine(noCycles).superRefine(uniqueKeys);
```

**Correction message (sent once):**
```text
Your plan output could not be used: {{errors}}.
Reply again with ONLY the corrected ```t3orchestra-result``` block. Do not change anything else.
```

### 9.3 Implementer (task thread, first run)

```text
You are implementing task #{{num}} of the board "{{boardName}}".
You are working in a dedicated git worktree on branch `{{branch}}` (based on `{{baseBranch}}`).

## Task: {{title}}
{{description}}

## Acceptance criteria
{{#acceptanceCriteria}}- {{.}}
{{/acceptanceCriteria}}

## Context
### Board brief
{{boardBrief}}
### Completed dependencies (already merged into {{baseBranch}})
{{#deps}}- #{{num}} {{title}}: {{summary}}
{{/deps}}

## Rules
- Stay within this task's scope. Note unrelated issues as follow-ups instead of fixing them.
- Follow the repo's existing conventions, linters and tests.
- Run the relevant tests / typecheck / lint before finishing; fix what you broke.
- Commit your work on `{{branch}}` with clear messages (prefix: `#{{num}}: `).
  Leave no uncommitted changes.
- If a product/design decision blocks you, ASK the user (question tool) instead of guessing.
- Do not merge into {{baseBranch}}, push, or open PRs unless asked.

## Output
End your final message with exactly one block:

```t3orchestra-result
{
  "status": "done | blocked",
  "summary": "What you did, 2-6 sentences",
  "changes": ["notable change 1", "…"],
  "testsRun": ["command → result"],
  "followUps": ["optional suggested follow-up tasks"],
  "blockedReason": "only if status is blocked"
}
```
```

```ts
const ImplementResult = z.object({
  status: z.enum(['done','blocked']),
  summary: z.string(),
  changes: z.array(z.string()).default([]),
  testsRun: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
  blockedReason: z.string().optional(),
});
```

`followUps` show in the drawer, each with an **"Add as task"** button.

### 9.4 Reviewer (new thread per round, project root, read-only)

```text
You are a code reviewer for task #{{num}} "{{title}}" (review round {{round}}).
The implementation lives in a separate worktree:
  path:   {{worktreePath}}
  branch: {{branch}}
  base:   {{baseBranch}}

Inspect it with read-only commands, e.g.
  git -C "{{worktreePath}}" diff {{baseBranch}}...HEAD
  git -C "{{worktreePath}}" status --porcelain
You MAY run tests/lint/typecheck inside that worktree. You must NOT edit, commit,
stage, or delete anything in either checkout.

## Task
{{description}}
## Acceptance criteria
{{#acceptanceCriteria}}- {{.}}
{{/acceptanceCriteria}}
{{#previousFindings}}## Findings from the previous round (verify they are fixed)
{{previousFindings}}{{/previousFindings}}

Review for: correctness, acceptance criteria met, broken tests, security issues,
obvious performance problems, and scope creep. Do not nitpick style the linter allows.

## Output
```t3orchestra-result
{
  "verdict": "pass | changes_requested",
  "summary": "1-4 sentences",
  "findings": [
    { "severity": "blocker | major | minor | nit",
      "file": "path", "line": 42,
      "title": "short", "detail": "what and why", "suggestion": "how to fix" }
  ]
}
```
```

**Strictness:** `board.reviewStrictness`, default `major`. The board treats the verdict as `changes_requested` only if some finding is **at or above** that severity, whatever the reviewer's own verdict says. Findings below it are shown but don't start a fix round.

### 9.5 Fix message (sent to the task thread)

```text
An AI reviewer found issues with your work on #{{num}} (round {{round}}).
Fix every blocker and major finding; address minor ones if cheap. Commit the fixes.
{{#findings}}
- [{{severity}}] {{file}}{{#line}}:{{line}}{{/line}}: {{title}}
  {{detail}}
  Suggested: {{suggestion}}
{{/findings}}
End with the same ```t3orchestra-result``` block format as before.
```

### 9.6 Other messages to the task thread
- **changes.md:** "The user reviewed your work and requests changes: {{feedback}} … same result block."
- **resume.md:** "Your previous run ended with status `{{status}}`. Check `git status` and the log, then continue the task until it is complete. {{note}} … same result block."
- **rebase.md:** "`{{baseBranch}}` has moved since you started and merging conflicts with your branch. Merge or rebase `{{baseBranch}}` into `{{branch}}`, resolve the conflicts preserving both intents, re-run the tests, commit. … same result block."
- **pr.md:** "Push `{{branch}}` and open a pull request against `{{baseBranch}}`, titled `#{{num}} {{title}}`, with a description summarising the change and how it was tested. End with the result block (status done)."

---

## 10. Data model (SQLite via Drizzle)

Data directory: `T3ORCHESTRA_HOME`, or by default `%APPDATA%\t3orchestra` (Windows) and `~/.t3orchestra` elsewhere. The database file is `t3orchestra.sqlite` with WAL mode on.

```ts
boards {
  id            text pk (uuid)
  name          text
  slug          text unique           // used in branch names
  short         text unique           // 4-char id for title markers, e.g. "7f3a"
  projectPath   text                  // repo root (absolute)
  t3ProjectId   text null             // learned from first thread
  baseBranch    text
  brief         text default ''       // markdown, prepended to implementer prompts
  autoRun       integer(bool) default 0
  maxParallel   integer default 3
  acceptInto    text default 'ready'  // 'ready' | 'backlog'
  aiReview      integer(bool) default 1
  skipReviewForTrivial integer(bool) default 1
  maxFixRounds  integer default 2
  reviewStrictness text default 'major'   // 'blocker'|'major'|'minor'
  avoidOverlap  integer(bool) default 1
  mergeStrategy text default 'local'      // 'local'|'pr'|'manual'
  defaultProvider text null
  defaultModel    text null
  plannerModel    text null
  reviewerModel   text null
  nextTaskNumber integer default 1
  createdAt, updatedAt, archivedAt null
}

plans {
  id, boardId fk, prompt text, options json,
  status text  // planning | needs_input | ready | refining | accepted | discarded | failed
  threadId text null, threadLink text null,
  currentVersion integer default 0, error text null,
  createdAt, updatedAt
}

plan_versions {
  id, planId fk, version integer, runId fk null,
  rawText text, parsed json null, validationErrors json null,
  createdAt
  unique(planId, version)
}

tasks {
  id text pk, boardId fk, number integer, planId null, planKey null,
  title, description, acceptanceCriteria json, category, complexity, priority,
  touches json, position real,          // fractional ordering within a column
  stage text, stageReason text null,
  attention text null,                  // question | approval | waiting | null
  threadId null, threadLink null, branch null, worktreePath null,
  fixRound integer default 0, reviewRound integer default 0,
  skipAiReview integer(bool) default 0,
  providerOverride null, modelOverride null,
  lastResult json null, lastSummary text null, resultMissing integer(bool) default 0,
  prUrl null, lastThreadStatus null, lastItemCount integer null,
  lastActivityAt null, startedAt null, completedAt null,
  activitySinceReview integer(bool) default 0,
  createdAt, updatedAt
  unique(boardId, number)
}

task_deps { taskId fk, dependsOnTaskId fk, primary key(taskId, dependsOnTaskId) }

runs {
  id text pk, boardId fk, taskId null, planId null,
  kind text   // plan | implement | fix | changes | resume | rebase | followup | pr | review
  threadId text, threadRole text  // 'task' | 'review' | 'plan'
  round integer null,             // review/fix round
  baselineRunId text null, t3RunId text null,
  status text  // starting | active | waiting | completed | failed | interrupted | cancelled | lost
  promptText text, resultRaw text null, resultJson json null, error text null,
  startedAt, finishedAt null
}

review_findings {
  id, taskId fk, runId fk, round integer,
  severity text, file text null, line integer null,
  title, detail, suggestion null,
  status text default 'open'   // open | addressed | dismissed
}

events {             // append-only audit + timeline
  id integer pk autoincrement, boardId, taskId null, planId null, runId null,
  type text, payload json, createdAt
}

notifications {
  id, dedupeKey text unique, boardId, taskId null, planId null,
  type text, title text, body text, createdAt, readAt null
}

settings { key text pk, value json }
```

**Indexes:** `tasks(boardId, stage)`, `runs(status)`, `runs(threadId)`, `events(taskId, id)`.

---

## 11. Backend

### 11.1 Modules (`apps/server/src`)

```
index.ts               boot: load settings, migrate DB, health check, start reconciler, HTTP
config.ts              data dir, ports, defaults
db/                    drizzle schema, migrations, repositories
t3/
  T3Client.ts          interface (below)
  CliT3Client.ts       CLI implementation
  FakeT3Client.ts      scripted fake for tests/dev ("T3ORCHESTRA_FAKE_T3=1")
  launcher.ts          resolves how to spawn the CLI on this OS
  health.ts            CLI found? server reachable? version
engine/
  transitions.ts       transition(taskId, event): the ONLY stage writer
  runs.ts              startImplementRun, sendTaskMessage, startReview, startPlanner
  reconciler.ts        polling loop (§8)
  scheduler.ts         auto-run (§7)
  results.ts           result block extraction + zod validation
  prompts.ts           template loading/rendering
git/
  git.ts               diff/stat/status/merge helpers (execa, no shell)
notify/
  notifier.ts          desktop notifications + dedupe (§12)
http/
  routes/*.ts          REST (§11.3)
  sse.ts               event stream (§11.4)
```

### 11.2 T3 adapter

```ts
export interface T3Client {
  health(): Promise<{ cliFound: boolean; serverReachable: boolean; version?: string; error?: string }>;
  startThread(o: {
    project: string;            // absolute repo path or project id
    message: string;            // always sent via stdin
    title: string;
    provider?: string; model?: string;
    worktree?: { baseRef: string; branch: string };
  }): Promise<{ threadId: string; runId?: string; link?: string }>;
  send(threadId: string, message: string): Promise<{ runId?: string }>;
  show(threadId: string, o?: { messages?: number }): Promise<{ thread: ThreadDetail; messages: ThreadMessage[] }>;
  list(project: string): Promise<ThreadSummary[]>;
  addProject(path: string): Promise<void>;
}
```

**Spawning the CLI (important on Windows):**
- Node refuses to spawn `.cmd` or `.bat` files without `shell: true` (since the CVE-2024-27980 fix), and `shell: true` combined with user text is a command-injection risk. So:
  1. `launcher.ts` reads `t3.cmd` at startup and extracts the exe path and the `bin.mjs` path (the `"…exe" "…bin.mjs" %*` line). It then spawns **the exe directly** with env `ELECTRON_RUN_AS_NODE=1`, `T3CODE_HOME=<~/.t3>` and `T3CODE_CLI_PATH`, and passes the args as an array (no shell).
  2. **Fallback:** if parsing fails, run `cmd.exe /d /s /c <t3.cmd> …args`. Allow this only for args the app builds itself (ids, slugs and refs, each checked against `^[A-Za-z0-9._\-/:]+$`).
  3. On macOS and Linux, spawn `t3` from `settings.t3CliPath`, or `PATH`.
  4. **Prompts and messages always go through stdin** (`-`), never as arguments. This also gets around the ~8 KB command-line limit on Windows.
- Re-resolve the launcher whenever a spawn fails with ENOENT; T3 updates can move the exe.
- **Timeouts:** 30s for `list` and `show`, 60s for `start` and `send`.
- **Retries:** `list` and `show` retry with backoff (3 attempts). `start` and `send` are **never retried blindly**; see §15.3.
- Parse stdout as JSON, capture stderr for logs, and turn non-zero exits into a `T3CliError { code, stderr }`.

### 11.3 REST API (JSON; mutating calls need header `X-T3Orchestra: 1`)

```
GET    /api/health
GET    /api/settings                 PATCH /api/settings
GET    /api/boards                   POST  /api/boards
GET    /api/boards/:id               PATCH /api/boards/:id      DELETE /api/boards/:id (archive)
POST   /api/boards/:id/validate-project
POST   /api/boards/:id/add-to-t3

POST   /api/boards/:id/plans                  { prompt, options }
GET    /api/plans/:id                          (with versions + proposed tasks)
PATCH  /api/plans/:id/proposals/:key           edit a proposed task (stored as a new user-edited version)
POST   /api/plans/:id/refine                   { feedback }
POST   /api/plans/:id/accept                   { keys?: string[] }
POST   /api/plans/:id/discard

GET    /api/boards/:id/tasks                   (TaskView[] incl. deps + derived column)
POST   /api/boards/:id/tasks                   manual task
GET    /api/tasks/:id                          (detail incl. runs, findings, recent events)
PATCH  /api/tasks/:id                          title/description/criteria/deps/priority/touches/position/overrides
POST   /api/tasks/:id/actions/:action          start | move-to-ready | move-to-backlog | resume | retry-fresh |
                                               request-changes {text} | send-message {text} | rerun-review |
                                               approve | update-branch | open-pr | mark-done | discard |
                                               dismiss-finding {findingId}
GET    /api/tasks/:id/diff?view=stat|full      { base, head, behindBy, uncommitted, files[], patch? }
GET    /api/tasks/:id/events?after=<id>

GET    /api/stream                             SSE (all boards; client filters)
```

Actions return `{ ok: true, task }` or `{ ok: false, error: { code, message } }`. Error codes include `ILLEGAL_TRANSITION`, `DEPS_NOT_DONE` (needs `{force:true}`), `T3_UNAVAILABLE`, `MERGE_CONFLICT`, `DIRTY_ROOT`, `DIRTY_WORKTREE`.

### 11.4 Server-sent events

`GET /api/stream` sends:
```
event: task      data: TaskView
event: plan      data: PlanView
event: board     data: BoardView
event: health    data: { cliFound, serverReachable }
event: notify    data: { id, type, title, body, taskId?, planId? }
```
It sends a heartbeat every 15s. On reconnect, the client refetches the board with TanStack Query (no event replay in v1).

---

## 12. Notifications

**When:**

| Trigger | Message |
|---|---|
| Task attention set | "#7 Add OAuth callback needs your input" |
| Plan needs input | "Planner needs your input: <plan title>" |
| Plan ready for review | "Plan ready: 12 tasks proposed" |
| Task enters `human_review` | "#7 ready for review (AI passed)" or "(2 major unresolved)" |
| Task enters `failed` | "#7 failed: run interrupted" |
| Board finished (every non-discarded task is done) | "Board <name>: all tasks done 🎉" |
| T3 unreachable for more than 60s | "T3 Code is not reachable; auto-run paused" |

- **Dedupe key:** `type:taskId:runId`, so each one fires once per run.
- **Channels (v1):**
  1. A **desktop toast** from the backend through `node-notifier` (Windows toast, macOS notification centre, libnotify). It works even with the board tab closed. Clicking it opens `http://127.0.0.1:<port>/b/<board>/t/<num>` in the default browser.
  2. An **in-app toast** plus a **tab title badge**: `(3) T3 Orchestra`, where 3 is the number of tasks needing attention or review.
  3. An optional sound (setting).
- Each trigger can be switched on or off in Settings.
- **Later:** phone push through ntfy or a webhook URL.

---

## 13. Git, worktrees and merging

- **Worktrees:** T3 creates them (`--worktree <base> --branch <branch>`). T3 Orchestra never runs `git worktree add` or `remove`. It reads `worktreePath` and `branch` back from `thread show`.
- **Branch names:** `t3orchestra/<boardSlug>/<num>-<slugified-title, max 40 chars>`, with `-r2`, `-r3` and so on for fresh retries.
- **Diff endpoint:**
  - `git -C <wt> diff --numstat <base>...HEAD` and `git -C <wt> diff <base>...HEAD`
  - `git -C <wt> status --porcelain` for uncommitted files
  - `git -C <root> rev-list --count HEAD..<base>`, run from the task branch's point of view, to compute "behind by"
- **Merge strategies (`board.mergeStrategy`):**
  - **`local`** (default for repos without a remote):
    1. The task worktree must be clean (`DIRTY_WORKTREE` otherwise; offer "Ask agent to commit").
    2. The root checkout must be **on `baseBranch` and clean** (`DIRTY_ROOT` otherwise, with a clear explanation).
    3. Run `git -C <root> merge --no-ff <branch> -m "#<num> <title> (T3 Orchestra)"`.
    4. On conflict, run `git merge --abort`, set reason `merge_conflict`, and offer **Update branch** (the rebase template).
    5. On success, transition to `done` and record the merge commit SHA in an event.
  - **`pr`:** **Approve** sends the PR template to the task thread. When the run finishes, the PR URL is read from `thread.pullRequests` or `linkedPullRequest` and shown on the card. **Done** is set by *Mark done*, or automatically if PR state is available (§4.5, item 7).
  - **`manual`:** Approve just marks the task done; you merge yourself.
- **Never** force-push, delete branches or remove worktrees automatically in v1.

---

## 14. Frontend

### 14.1 Routes
```
/                              boards list (+ health banner)
/b/:boardSlug                  board
/b/:boardSlug/t/:num           board + task drawer open
/b/:boardSlug/plans/:planId    plan screen (status / review)
/settings                      global settings
```

### 14.2 Board layout

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ ◧ T3 Orchestra ▾  my-app  (C:\code\my-app · base: main)     [New plan] [New task]            │
│ Auto-run [■ on]  Parallel [ - 3 + ]  Running 2/3   Needs you: 1   🔍 filter   ⚙          │
├──────────┬──────────┬──────────┬────────────┬──────────┬──────────────┬────────┬─────────┤
│ Backlog 4│ Ready 3  │ Running 2│ Needs In. 1│ AI Rev. 1│ Human Rev. 2 │ Done 5 │ Failed 1│
│ ┌──────┐ │ ┌──────┐ │ ┌──────┐ │ ┌────────┐ │ ┌──────┐ │ ┌──────────┐ │        │         │
│ │#9 …  │ │ │#6 …  │ │ │#4 …  │ │ │#7 …    │ │ │#5 …  │ │ │#2 …      │ │        │         │
│ │      │ │ │after │ │ │●●◐○○ │ │ │❓asks  │ │ │r1 ◐  │ │ │✓ AI pass │ │        │         │
│ │[Start]│ │ │ #4  │ │ │6m·41 │ │ │[Open T3]│ │ │      │ │ │[Review]  │ │        │         │
│ └──────┘ │ └──────┘ │ └──────┘ │ └────────┘ │ └──────┘ │ └──────────┘ │        │         │
└──────────┴──────────┴──────────┴────────────┴──────────┴──────────────┴────────┴─────────┘
```

**Card contents (top to bottom):**
- `#num`, title (2-line clamp), and a T3 link icon (opens the thread)
- chips: category · complexity · priority (only high is coloured) · `after #3 #4` (dependency chips; red if blocked)
- the pipeline strip (§6.4)
- a status line that depends on the column:
  - Backlog/Ready: "Waiting for #3" · "Waiting for slot (3/3)" · "Auto-run off" · "Ready"
  - Running: "Implementing · 6m · 41 events", or "Fix round 1 · 2m"
  - Needs Input: "❓ Asking a question", "🔐 Waiting for approval", or "Waiting"
  - AI Review: "Review round 2 · 1m"
  - Human Review: "✓ AI passed", "⚠ 2 major unresolved", "⚠ Merge conflict" or "AI review skipped", plus `+120 −30 · 6 files`
  - Failed: the reason, plus the first line of the agent's last message
- context buttons (at most 2): Start · Open in T3 · Review · Resume

**Drag and drop (dnd-kit):**

| Drag | Means | Notes |
|---|---|---|
| Backlog ↔ Ready | move | Reordering within a column changes `position` |
| Backlog/Ready → Running | start | Confirms if dependencies aren't done |
| Human Review → Done | mark done | Confirms |
| Failed → Backlog | move back | Resets the thread link; the old thread is kept in history |

Other drops are refused with a tooltip. In particular, cards in Running, Needs Input or AI Review can't be dragged, because v1 can't stop threads.

**Keyboard:** `N` new task · `P` new plan · `/` filter · `Esc` close the drawer · `[` `]` previous/next card in the drawer.

### 14.3 Task drawer (right side, 50% width; full screen on small screens)

- **Header:** `#num title` (editable while in backlog or ready), stage badge, reason badge, and actions for the current stage.
- **Tabs:**
  1. **Overview:** description (markdown, editable before start), acceptance criteria, dependencies (editable before start), touches, overrides (model, skip AI review).
  2. **Activity:** a timeline of runs (kind, round, thread link, status, duration). Each finished run shows the agent's summary (markdown) and, when expanded, the full last message. `events` rows appear in between ("moved to Ready by scheduler").
  3. **Review:** the implementer's result, AI findings (filter by severity; dismiss), the diff viewer and the merge or PR actions.
- **Composer at the bottom** (in human_review or failed): "Message the agent…", with buttons **Send**, **Request changes** and **Resume**.
- **Needs-input banner:** "The agent is waiting for you in T3." with an **Open in T3** button.

### 14.4 Plan screens
- **Composer** (modal or page): a large markdown editor (autosaves a draft to localStorage), options (§5.2), and **Generate plan**.
- **Status view:** a spinner with elapsed time, a link to the planner thread, and the needs-input banner when relevant.
- **Review view:**
  - summary, assumptions and open questions (collapsible)
  - a table of proposed tasks with inline editing, a checkbox per row, a "+ add task" row and a delete button per row
  - a **waves** panel (Wave 1: T1; Wave 2: T2 T3 T5; …) with cycle errors shown inline
  - a **Refine** box and **Accept selected / Accept all / Discard** buttons
  - for plan versions above 1, a "changed since v1" highlight

### 14.5 Settings page
- **T3:** CLI path (auto-detected, can be overridden), detected version, server URL, a **Test connection** button
- **Polling:** active and idle intervals, stale threshold
- **Parallel:** global max parallel
- **Notifications:** switch per trigger, sound
- **Defaults for new boards:** every board setting
- **Prompts:** which templates are overridden, with a button to open the overrides folder
- **Data:** the data directory path, plus exporting a board as JSON

### 14.6 Visual style
- Dark theme by default with a light theme, using shadcn/ui tokens.
- One column colour per stage, used as a thin top border on the column (Aperant uses a similar touch).
- Monospace for `#num`, branches and paths.
- Empty states for each column: "Nothing running", "No tasks waiting on you" and so on.

---

## 15. Error handling and edge cases

### 15.1 T3 not running or unreachable
- The health check runs every 10s and on CLI errors. It sends `health` over SSE and the UI shows a red banner: *"T3 Code isn't running. Start the T3 app to continue."*
- The scheduler pauses and the reconciler backs off to `pollIdleMs`. Nothing is marked failed because T3 is down.

### 15.2 Thread disappears
`show` returns not-found for a tracked run's thread: the run becomes `lost` and the task becomes `failed (thread_missing)`.

### 15.3 Start and send are not idempotent: recovering from crashes and timeouts
- Every thread title includes a marker: `[tb <boardShort>-<num>]` for task threads, `[tb <boardShort>-<num> r<round>]` for review threads, `[tb <boardShort> plan-<n>]` for planner threads.
- Before calling `start`, insert the `runs` row with status `starting`.
- If `start` times out or errors, **don't retry right away**. Run `list` and look for a thread with the marker created in the last 5 minutes.
  - **Found:** link it and continue.
  - **Not found:** mark the run `failed` (`start_failed`), with **Retry** in the UI.
- On boot, any run still `starting` gets the same marker lookup.
- For `send`, store `baselineRunId` first. If the send errors, check whether `latestRunId` moved before offering a resend.

### 15.4 Other cases
- **Manual edits in T3:** see §8, *runs started outside the app*.
- **Plan too big or malformed:** zod limits (40 tasks), one automatic correction, then you decide.
- **Dependency cycles from manual edits:** `PATCH` rejects with `DEP_CYCLE`.
- **Discarding a task that others depend on:** the dependents show "blocked by #3 (discarded)", and the drawer offers "Remove dependency".
- **Two boards on the same repo:** allowed. Branch names include the board slug, and `avoidOverlap` only applies within a board.
- **Base branch moves while tasks run:** expected. The diff shows "behind by N", and a merge conflict leads to *Update branch*.
- **Root checkout dirty or on another branch at merge time:** a clear `DIRTY_ROOT` error. The app never stashes on your behalf.
- **Very long agent messages:** store them in full; the UI truncates with "show more".
- **Clock and timezone:** store ISO UTC; show local relative times.

---

## 16. Security
- The HTTP server binds to **127.0.0.1 only** (configurable port, default **4417**).
- **DNS-rebinding guard:** reject requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`.
- **CSRF guard:** mutating requests need the `X-T3Orchestra: 1` header. Browsers won't send custom headers cross-origin without a CORS preflight, and the server doesn't allow cross-origin requests.
- No shell interpolation anywhere: execa with argument arrays, prompts through stdin, and identifiers checked against an allow-list regex.
- **Secrets:** none stored. Prompts and agent output stay in the local SQLite file.
- **Agent permissions:** threads started from the CLI use T3's default runtime mode for the project, which may be `full-access`. Show this in board settings so it's a conscious choice.

---

## 17. Project structure and tooling

```
t3orchestra/
├─ package.json                 # pnpm workspaces, scripts
├─ pnpm-workspace.yaml
├─ apps/
│  ├─ server/                   # Node 22, TypeScript, Hono
│  │  ├─ src/…                  # see §11.1
│  │  ├─ prompts/*.md           # §9 templates
│  │  └─ drizzle/               # migrations
│  └─ web/                      # Vite + React + TS
│     └─ src/
│        ├─ routes/             # boards, board, plan, settings
│        ├─ components/         # Board, Column, TaskCard, TaskDrawer, DiffView, PlanTable, …
│        ├─ api/                # typed client + SSE hook
│        └─ lib/
├─ packages/
│  └─ shared/                   # zod contracts, enums, columnFor(), transition table, types
└─ docs/
   ├─ spec.md                   # this file
   └─ t3-cli-notes.md           # findings from M0 spikes
```

**Libraries** (latest stable when scaffolding):
- **Server:** `hono`, `@hono/node-server`, `zod`, `drizzle-orm`, `better-sqlite3`, `drizzle-kit`, `execa`, `pino`, `node-notifier`, `mustache`, `open`
- **Web:** `react`, `react-dom`, `@tanstack/react-query`, `react-router` (or TanStack Router), `@dnd-kit/core` and `@dnd-kit/sortable`, `tailwindcss`, shadcn/ui (Radix), `lucide-react`, `react-markdown` and `remark-gfm`, `react-diff-view` (or `diff2html`)
- **Dev:** `vitest`, `@playwright/test` (smoke tests later), `eslint`, `prettier`, `tsx`, `concurrently`

**Scripts:**
- `pnpm dev`: the server on :4417 (tsx watch) plus Vite on :5173, which proxies `/api` to :4417
- `pnpm build`: build web, then server. In production the server serves `apps/web/dist`.
- `pnpm start`: run the built server and open the browser
- `pnpm test`: vitest across the workspace
- `T3ORCHESTRA_FAKE_T3=1 pnpm dev`: use `FakeT3Client` (no real agents) for UI work

---

## 18. Testing strategy

- **Unit (shared):** `columnFor`, every row of the transition table (allowed and refused), dependency cycle detection, waves, the `overlapsActive` prefix logic.
- **Unit (server):**
  - result-block extraction: several blocks, other code blocks, broken JSON, missing block
  - prompt rendering
  - branch slugs
  - the launcher's `t3.cmd` parsing (fixture file)
- **Engine (with `FakeT3Client`):** scripted thread timelines, for example `starting → running → waiting → running → completed (with result)`, checking:
  - stages and attention as the timeline plays out,
  - the AI review loop: pass, changes then pass, and changes with no rounds left,
  - the scheduler: slots, dependencies, priority, overlap, pause,
  - crash recovery: a run left `starting` plus a marker lookup,
  - runs started outside the app, a missing thread, T3 down.
- **Git helpers:** a temp repo fixture for diff, behind-by, merge success and merge conflict with abort.
- **E2E smoke (Playwright, fake T3):** create a board, plan, accept, then watch the cards move through the columns.
- **Manual acceptance (real T3):** see each milestone's checks.

---

## 19. Milestones (build order)

Each milestone ends with its acceptance checks passing.

**M0: Scaffold and T3 adapter spike**
- Workspace, lint, test setup, `packages/shared` skeleton
- `launcher.ts`, `CliT3Client` (list, show, start, send through stdin), `/api/health`
- Answer the §4.5 questions in `docs/t3-cli-notes.md`
- ✅ `/api/health` reports CLI found and server reachable. A script can start a trivial thread in a scratch repo and read its result.

**M1: Boards and manual tasks**
- DB schema and migrations, boards CRUD with project validation, the manual task form
- Board UI with the 8 columns, cards, drag between Backlog and Ready, ordering, the task drawer Overview tab
- ✅ Create a board for a real repo, add 3 tasks, reorder them, and see the changes survive a restart.

**M2: Run engine and live status**
- `startImplementRun`, the reconciler, `transitions.ts`, attention, the Failed column, SSE, Open in T3, the Activity tab
- ✅ Starting a manual task shows it Running, then (if it asks something) Needs Input, then Human Review, with no page refresh.
- ✅ Killing the backend mid-run and restarting it recovers the correct state.

**M3: Planner**
- Composer, planner run, result validation and correction, the plan screen, refine, accept with dependencies, the board brief
- ✅ A 1-paragraph goal produces at least 5 tasks with dependencies. Editing one, deleting one and accepting puts them on the board with the dependency chips right.

**M4: Scheduler and auto-run**
- Slots per board and globally, the dependency gate, priority and position order, overlap avoidance, pause, the health gate
- ✅ With auto-run on and a parallel limit of 2, only 2 run at once, and dependents start only after their dependencies are Done.

**M5: AI review loop**
- Reviewer threads, findings storage and UI, fix rounds, strictness, skip rules, re-run review
- ✅ A task with a planted bug gets a "changes requested" review, a fix round, and then "AI passed" (or "unresolved" when rounds run out).

**M6: Human review and merge**
- Diff endpoint and viewer, request changes, send message, local merge with conflict handling, update branch, PR mode, mark done, discard, resume, retry fresh
- ✅ An approved task merges into base locally. A forced conflict leads to Update branch, which leads to a clean merge.

**M7: Notifications and polish**
- node-notifier toasts with click-through, the title badge, in-app toasts, per-trigger switches, empty states, keyboard shortcuts, the settings page
- ✅ With the browser closed, a task needing input raises a desktop toast that opens the task.

**M8: Hardening**
- Title-marker idempotency, backoff, an orphan scan, logging (pino to `<dataDir>/logs`), the Playwright smoke test, the README
- ✅ Every §15 case is covered by a test or a written manual check.

---

## 20. Later (v2+)

1. **WebSocket adapter:** connect to the T3 server (`ws://127.0.0.1:3773/…`, using a scoped bearer token from `t3 auth session issue --scope orchestration:read --scope orchestration:operate --label t3orchestra`). That would give:
   - live push updates instead of polling,
   - **answering questions and approvals inside T3 Orchestra**,
   - **stopping and interrupting threads**,
   - starting threads in **plan mode** and setting runtime mode,
   - archiving threads and cleaning up worktrees.

   This depends on T3 Code's protocol, which isn't documented as public, so check it against T3 Code's source and version-gate it. Keep `T3Client` the same so the board logic doesn't change.
2. **Progress tool (MCP):** a small MCP server shipped with T3 Orchestra, exposing `report_progress(step, total, note)`, `add_follow_up_task(...)` and `get_task_context()`. Agents report progress through structured calls (Aperant's best idea), which enables real subtask dots on the card. It needs §4.5 item 6.
3. **Stacked dependencies:** dependents start from their dependency's branch before it's merged (`--worktree <depBranch>`), with automatic restacking.
4. **Plan-approval gate per task:** the agent writes a plan first (plan mode through WS), and you approve it before coding.
5. **Sources:** import GitHub issues as tasks, or as the big prompt. Sync PR state for automatic Done.
6. **Ideation and roadmap:** scanner prompts (security, performance, UX, docs, tests) that propose task cards into a "Suggestions" lane.
7. **Changelog:** release notes generated from Done task summaries, grouped by category.
8. **Remote machines:** run tasks on other linked T3 environments (`environmentId`).
9. **Cost and usage per task and board,** if T3 exposes it.
10. **Phone push** (ntfy or a webhook), and a phone-friendly board layout.
11. **Task templates** (bug fix, feature, refactor) with tuned prompts.

---

## 21. Open questions (decide during build)
1. Should Needs-Input threads count toward the parallel limit? **Default yes**, because they hold a worktree and context. Make it a board setting if it gets annoying.
2. Should Done tasks' T3 threads be archived automatically once the WS adapter exists? Probably yes, behind a setting.
3. When the board brief grows large, should older plan summaries be shortened? It's not a concern for v1.
4. Should one board's plan be able to add tasks to another board? No.

---

## Appendix A: Lessons from Aperant (AndyMik90/Aperant, AGPL-3.0, ideas only)

**What we borrow:**
- AI review before human review
- a parallel limit with a queue
- a worktree per task
- complexity tiers that skip ceremony for trivial tasks
- result summaries and follow-ups
- turning AI-generated suggestions into cards
- a progress strip instead of a fake percentage
- reporting progress through structured tool calls (v2)

**What we avoid:**
1. **Files as the database.** Their task status lived in JSON plan files that agents also rewrote, which caused wiped or corrupted status, atomic-write fixes and two-copy merging. *Ours:* SQLite, written only by the backend; agents only send result blocks.
2. **Several sources of truth for status:** the state machine, plan files, progress events, the UI's stuck detector and backup timers, which led to repeated "card in the wrong column" bugs. *Ours:* one `transition()` function, plus one pure `columnFor()`.
3. **Queue logic inside a React component,** so auto-start only worked while the board was on screen. *Ours:* the scheduler is in the backend.
4. **Dependencies collected but never used** in scheduling. *Ours:* the dependency gate is enforced, and dependency chips are visible.
5. **Errors hidden inside the Human Review column.** *Ours:* a separate Failed column with a clear reason.
6. **No real "needs input" state;** prompts assumed a live user that the pipeline didn't support. *Ours:* T3's `waiting` and pending requests become a first-class Needs Input column, plus notifications.
7. **A plan-approval setting that didn't actually gate anything.** *Ours:* don't ship a gate until it really blocks (v2, via WS plan mode).
8. **Brittle LLM output handling** (several repair passes, field renaming). *Ours:* one tagged result block, a zod schema, at most one correction message, and then show the raw output to you.
9. **Notifications only on process exit.** *Ours:* notifications for attention, review-ready, failed and plan-ready.
