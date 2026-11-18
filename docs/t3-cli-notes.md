# T3 CLI notes (M0 spike findings)

Recorded 2026-11-05 against **T3 Code 0.1.8-nightly.20261104.4165** (desktop, nightly) on Windows 10,
by `apps/server/scripts/spike.ts` (`pnpm --filter @t3-orchestra/server spike <scratch-repo> [report.json]`).
The adapter (`apps/server/src/t3/`) follows these findings; re-run the spike after T3 updates.

## Launching

- `~/.t3/bin/t3.cmd` sets `T3CODE_CLI_PATH`, `T3CODE_HOME` (only if undefined), `ELECTRON_RUN_AS_NODE=1`,
  `T3CODE_DESKTOP_CLI_LAUNCHER=1`, then runs `"…\T3 Code (Nightly).exe" "…\resources\server.asar\apps\server\dist\bin.mjs" %*`.
  `launcher.ts` parses exactly this shape and spawns the exe directly (no shell). Verified working.
- A read (`thread list`/`show`) takes ~0.4–0.7 s wall time.
- Server health: `~/.t3/userdata/server-runtime.json` → `{ pid, host, port, origin, serverVersion }`. The origin
  serves the web app (HTTP 200 on any path), so `health()` = runtime file present + pid alive + `fetch(origin)` succeeds.

## Command outputs

| Command | Observed `--json` stdout |
|---|---|
| `thread start … <project> -` | `{"threadId":"mcp:<uuid>","projectId":"<uuid>","runId":"run:thread:mcp%3A<uuid>:ordinal:1"}` — **no `link`**; read it from `show`/`list` afterwards. |
| `thread send … <thread> -` | `{"threadId","link","messageId","runId":"…:ordinal:2","status":"starting","delivery":"started"}` |
| `thread show --json` | as in spec §4.3, plus `titleRegeneration`, `settledAt`, `snoozedUntil`. |
| `thread list --json` | array of summaries (spec §4.3 minus `messages`, `activeRunId`, `branch`, `worktreePath`, `pendingRequestCount`, **`runCount`, `archived`**). Newest first. |
| `project add <path>` (text) | `Added project <uuid> (<name>) at <path>.` |

Error shapes (exit code 1, message on stderr):
- unknown thread: `Thread <id> is no longer available.` → adapter maps to `notFound`.
- unknown project: `No T3 Code project matches '<path>'. Pass a project id or a path inside a project.`
  → used by project validation (`t3Known = false`), offer "Add to T3".

## IDs

- CLI-created thread ids carry an `mcp:` prefix (`mcp:2d30a343-…`); UI-created ones are bare uuids. Treat ids as opaque.
- Run ids URL-encode the thread id: `run:thread:mcp%3A<uuid>:ordinal:<n>`. Compare run ids as opaque strings;
  `runOrdinal()` parses `:ordinal:<n>` from the end, which is safe with the encoding.

## Answers to spec §4.5

1. **`start`/`send` JSON:** see the table. Both return `runId`, so runs store `t3RunId` and "started" is
   `latestRunId === t3RunId` (with the `baselineRunId` comparison as fallback). `start` has no `link`.
2. **`list` pagination/cap:** not observed (only a few threads per test project; no paging fields in the output).
   Not verified for large projects — the reconciler falls back to `show` for any tracked thread missing from `list`,
   so a cap would only cost extra calls.
3. **`send` to a thread with a pending question:** *not verified* (it would leave an unanswerable question in
   the user's T3). `send` reports `delivery`; we saw `"started"` on an idle thread and assume `"queued"` for busy or
   waiting threads, per the CLI help ("A busy thread gets it as its next turn; nothing is interrupted").
   T3 Orchestra never sends to a thread in `waiting`, so this only matters for manual chats.
4. **Runtime mode of CLI-started threads:** `runtimeMode: "full-access"`, `interactionMode: "default"` (the
   project/app defaults). The board records the observed mode (`boards.observed_runtime_mode`) and the settings
   dialog shows it (spec §16).
5. **Finished runs:** all three spike runs ended in **`completed`** (`activeRunId: null`). Statuses seen in order:
   plain thread `running → completed`; worktree thread `preparing → running → completed`. `idle` + `runCount > 0`
   is still treated as finished-OK, defensively.
6. **`.mcp.json` loading:** not checked yet (needed only for the v2 progress tool).
7. **`pullRequests[]` state:** no PRs were opened in the spike, so the item shape is unknown. `prUrlOf()` and
   `prStateOf()` accept `url`/`htmlUrl`/`link` and `state`/`status`/`merged`/`mergedAt`; `pr.merged` fires only
   when a state of `merged` is actually present.

## Worktrees

- `--worktree main --branch t3orchestra/spike/1-hello-…` created the branch and a worktree at
  `~/.t3/worktrees/<projectName>/<branch with / → ->` and reported both in `show` (`branch`, `worktreePath`).
- The agent committed on that branch (`git log` in the worktree showed `#1: add hello`), `status --porcelain` was clean.
- `thread list` does **not** include `branch`/`worktreePath`; the reconciler reads them from `show`.

## Attention

- `pendingRequestCount` is only in `show`. The CLI does not say whether a pending request is a question or an
  approval, so `attention` is `'waiting'` unless T3 exposes more later. The UI shows "Waiting for you".

## Settling threads (verified 2026-11-05, same T3 version)

The CLI has no settle command (`thread` only has `list`/`start`/`send`/`show`). `CliT3Client.settleThreads()` uses
T3's own WebSocket RPC instead (`apps/server/src/t3/T3Ws.ts`):

1. `t3 auth session issue --scope orchestration:read --scope orchestration:operate --ttl 5m --label "T3 Orchestra" --json`
   → `{ sessionId, token, … }` (subject `cli-issued-session`). Revoked with `t3 auth session revoke <id>` afterwards.
2. `ws://<origin>/ws?orchestrationProtocol=2` with `Authorization: Bearer <token>` (without the query param: HTTP 426).
3. Effect RPC JSON frames: send `{"_tag":"Request","id":"1","tag":"orchestration.dispatchCommand","payload":{"type":"thread.settle","commandId":"<uuid>","threadId":"…"},"headers":[]}`,
   get `{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":{"sequence":…}}}`. Settling twice succeeds;
   an unknown thread fails with `"No orchestration projection exists for thread …"`.

Dead end: T3's `/mcp` endpoint (what the CLI itself calls, tool `t3_thread_organize` with `action: "settle"`) accepts
a token issued with `--subject mcp-client`, but such a session's access is capped at `approval-required`, and
changing a `full-access` thread fails with `runtime_mode_escalation_denied`. The CLI gets full access only because
it mints its MCP session in-process.

`thread list --json` (and `show`) report `settled` and `settledAt`. T3's storage cleanup may later remove the
worktree of a thread settled for N days, if the user set that up in T3 (it checks for local changes first).

## Providers and models (verified 2026-11-07, same T3 version)

- `thread start` rejects `--provider` without `--model` and vice versa (`--provider and --model go together.`),
  despite the help text. `CliT3Client.startThread` fills in the missing half (`resolveModelSelection`): a model
  alone goes to a provider that offers it (T3's default provider first), a provider alone gets its default model.
- The CLI cannot list providers. `server.getConfig` over `/ws` does, with a session issued with only
  `--scope orchestration:read`. Its result has `providers[]` (`instanceId`, `displayName`, `enabled`, `status`,
  `models[]` of `{ slug, name, isDefault?, isLegacy?, aliases? }`; disabled providers are listed too) and
  `settings` (`defaultModelSelection.instanceId`, `providerModelPreferences[instanceId].hiddenModels`/`modelOrder`).
  The result is ~700 KB (slash commands, skills, usage), so the board caches its trimmed catalog for a minute
  (`GET /api/t3/models`).

## Listing projects (verified 2026-11-08, same T3 version)

- The CLI has no `project list`. `orchestration.subscribeShell` over `/ws` (payload `{}`, needs only
  `orchestration:read`) is a stream: its first `Chunk` has an item `{ kind: "snapshot", snapshot: { projects,
  threads, archivedThreads, … } }`. `T3Ws.getShellSnapshot` takes it, sends `{"_tag":"Interrupt","requestId":"1"}`
  and closes. On this machine: 28 projects and ~1,180 threads, about 2 s including issuing and revoking the session.
- Project shells: `id`, `title`, `workspaceRoot`, `archivedAt`, `deletedAt`, `updatedAt`. Thread shells carry
  `projectId`, `lineage.parentThreadId` (set on sub-agent threads), `latestUserMessageAt`, `deletedAt`,
  `archivedAt`, `pendingBackgroundTasks` and more.
- `thread list --json` now also has `parentThreadId`, `settled`, `settledAt`, `createdBy`, `creationSource`, and
  seems to leave out one or two threads the snapshot counts.

## Side effects of the spike

- Project `t3orchestra-spike-repo` (scratch repo in the session scratchpad) was added to T3 with two finished
  threads. Remove it with `t3 project remove <id>` when no longer needed.
