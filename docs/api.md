# T3 Orchestra REST + SSE API (v1)

Implements spec §11.3 / §11.4 with a few additions (marked **+**). All types live in
`packages/shared/src` (`views.ts`, `contracts.ts`, `enums.ts`) and are imported by both apps
as `@t3-orchestra/shared`.

- Base URL: `http://127.0.0.1:4417` (Vite dev server on :5173 proxies `/api` with `changeOrigin: true`).
- JSON everywhere. **Every mutating request (POST/PATCH/PUT/DELETE) must send `X-T3Orchestra: 1`**,
  otherwise the server answers 403.
- Errors: non-2xx status with body `{ ok: false, error: { code: ErrorCode, message, details? } }`.
  Validation errors use code `VALIDATION` and put zod issues in `details`.

## Health & settings

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | | `HealthView` |
| GET | `/api/settings` | | `AppSettings` |
| PATCH | `/api/settings` | `PatchSettings` (deep-partial for `notifications`, `boardDefaults`) | `AppSettings` |
| GET | `/api/settings/info` **+** | | `SettingsInfo`: `{ dataDir, port, publicUrl, fake, launcher: { kind, command, cliPath } \| null, promptsDir, overriddenPrompts: string[], templates: string[] }` |
| POST | `/api/settings/test-connection` **+** | | `HealthView` (forces a fresh check) |
| POST | `/api/settings/open-prompts-dir` **+** | | `{ ok: true }` (opens the overrides folder in the OS file browser) |

Global "Pause all" is `PATCH /api/settings { pauseAll: true }`.

## Boards

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/validate-project` **+** | `{ projectPath, baseBranch? }` | `ProjectValidation` (below) — used by the New-board form before creating |
| POST | `/api/add-to-t3` **+** | `{ projectPath }` | `ProjectValidation` (re-checked after `t3 project add`) |
| POST | `/api/folders/pick` **+** | `{ title?, startIn? }` | `{ path: string \| null }`: opens the OS's folder window on the computer running T3 Orchestra and answers when the user closes it (`null`: closed without choosing). 409 while another one is open, 501 when the OS has none (Linux without zenity/kdialog) |
| POST | `/api/folders/check-new` **+** | `{ parent, name }` | `{ path, error }`: may `name` be made inside `parent` (name rules, parent exists, no such folder yet) |
| GET | `/api/github/account` **+** | `?refresh=1` skips the 1-minute cache | `{ ok, login, owners, error }` from the user's `gh` CLI (`owners`: login, then its organizations) |
| POST | `/api/projects/setup` **+** | `SetupProjectBody` (below) | `ProjectSetupResult` (below). 400 `VALIDATION` before anything is touched when the request can't work |
| GET | `/api/boards` | | `BoardView[]` (not archived) |
| POST | `/api/boards` | `CreateBoardBody` | `BoardView` (400 `VALIDATION` with `details: ProjectValidation` if the project check fails) |
| GET | `/api/boards/:idOrSlug` | | `BoardView` |
| PATCH | `/api/boards/:id` | `PatchBoardBody` | `BoardView` |
| DELETE | `/api/boards/:id` | | `{ ok: true }` (archives) |
| GET | `/api/t3/projects` **+** | | `T3ProjectView[]`: T3's projects, most recently active first: `{ id, title, path, threadCount, lastActivityAt, boardSlug }` (`boardSlug`: a board already on it). 503 `T3_UNAVAILABLE` when T3 can't be read |
| POST | `/api/boards/:id/import` **+** | | `BoardView` with `projectImport.status: 'gathering'`: starts an import from T3 history (409 `ILLEGAL_TRANSITION` while one runs) |
| POST | `/api/boards/:id/validate-project` | | `ProjectValidation` |
| POST | `/api/boards/:id/add-to-t3` | | `ProjectValidation` |
| GET | `/api/boards/:id/export` **+** | | full JSON dump of the board (download) |

`ProjectValidation` and `SettingsInfo` are exported from `@t3-orchestra/shared`:

```ts
interface ProjectValidation {
  ok: boolean;               // path is a git repo, base branch exists, T3 knows the project
  toplevel: string | null;   // git toplevel (absolute)
  currentBranch: string | null;
  branches: string[];        // local branches, for the base-branch picker
  baseBranch: string | null; // the checked/defaulted base branch
  baseBranchExists: boolean;
  isGitRepo: boolean;
  exists: boolean;           // the path is an existing folder (git or not)
  originUrl: string | null;  // the `origin` remote, if any
  folderFiles: { count: number; more: boolean } | null; // not a repo yet: files a first commit takes (capped at 2000)
  setupBlocked: string | null; // why git must not be started here (drive root, home, Documents, Desktop…)
  t3Known: boolean;          // `t3 thread list --project <path>` succeeded
  t3Error: string | null;
  t3ThreadCount: number | null; // threads an import would read (no sub-agents, no T3 Orchestra reviews)
  errors: string[];          // human-readable problems
}
```

New board can also start from a folder that isn't a repository yet, or a new one. `POST /api/projects/setup` runs the asked-for steps in order and keeps the ones before a failed step:

```ts
interface SetupProjectBody {
  projectPath: string;
  createFolder?: boolean;       // mkdir (parent must exist, folder must not) + README.md
  initBranch?: string;          // `git init --initial-branch`, default .gitignore if none, first commit; required when not a repo
  github?: { owner: string; name: string }; // `gh repo create owner/name --private --source --remote origin --push`
  confirmManyFiles?: boolean;   // required when the folder has more than 2000 files
}
interface ProjectSetupResult {
  projectPath: string;          // absolute
  createdFolder: boolean;
  initializedGit: boolean;
  githubUrl: string | null;
  error: string | null;         // the step that failed
  validation: ProjectValidation; // after `t3 project add` when the folder is a repository
}
```

## Plans

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/boards/:id/plans` **+** | | `PlanView[]` (newest first, excludes discarded unless `?all=1`) |
| POST | `/api/boards/:id/plans` | `CreatePlanBody` | `PlanView` |
| GET | `/api/plans/:id` | | `PlanDetailView` |
| PATCH | `/api/plans/:id/proposals/:key` | `ProposalPatch` | `PlanDetailView` |
| POST | `/api/plans/:id/proposals` **+** | `PlanTask` (add a row) | `PlanDetailView` |
| DELETE | `/api/plans/:id/proposals/:key` **+** | | `PlanDetailView` |
| PUT | `/api/plans/:id/proposals` **+** | `{ tasks: PlanTask[] }` (replace all) | `PlanDetailView` |
| POST | `/api/plans/:id/refine` | `{ feedback?, answers?: { question, answer }[] }` **+** (at least one) | `PlanView` |
| POST | `/api/plans/:id/accept` | `{ keys?: string[] }` | `{ plan: PlanView, tasks: TaskView[] }` (400 `DEP_CYCLE`/`VALIDATION` if the selection is invalid) |
| POST | `/api/plans/:id/discard` | | `PlanView` |
| POST | `/api/plans/:id/retry` **+** | | `PlanView` (re-runs a `failed` plan's planner) |
| PUT | `/api/plans/:id/spec` **+** | `{ spec }` (the user's version of the current spec) | `PlanDetailView` |
| POST | `/api/plans/:id/spec/refine` **+** | `{ feedback?, answers?: { question, answer }[] }` (at least one) | `PlanView` (next spec round) |
| POST | `/api/plans/:id/spec/plan` **+** | `{ feedback?, answers? }` | `PlanView` (Generate tasks from the spec) |

User edits create (or update, if the current version is already a user version) a plan version
with `source: 'user'`. `changedKeys`/`addedKeys` compare the current version to the previous one.

Plan statuses: `speccing | spec_review | planning | needs_input | ready | refining | accepted | discarded | failed`.

**Spec-first plans** (`options.specFirst`): the planner thread first drafts a spec and asks questions
(run kind `spec`, status `speccing`); each reply is a spec round (`PlanDetailView.specRounds`, current text in
`spec`) and the plan waits in `spec_review`. `spec/refine` sends answers/a note for another round on the same
thread; `spec/plan` asks the same thread for tasks (then the usual `planning → ready`). The spec and answers
can change in `spec_review`, or in `failed` before any tasks exist. Retry starts a fresh thread from the last
good step: tasks from the spec when that step failed, else the spec so far. Tasks of an accepted spec-first
plan get the spec in their implement prompt.

## Tasks

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/boards/:id/tasks` | `?discarded=1` to include discarded | `TaskView[]` |
| POST | `/api/boards/:id/tasks` | `CreateTaskBody` (`dependsOn` = task ids) | `TaskView` (goes to Backlog) |
| GET | `/api/tasks/:id` | | `TaskDetailView` (`screenshots` **+**: images in `<dataDir>/screenshots/<taskId>/<attempt>/`, oldest first) |
| GET | `/api/tasks/:id/screenshots/:name` **+** | | the image (png, jpg, webp or gif from the current attempt's folder; 404 otherwise) |
| GET | `/api/tasks/:id/designs/:round/:name` **+** | | a file of a round of design options in `<dataDir>/designs/<taskId>/<round>/` (html pages and the css/js/images/fonts they load; 404 otherwise), served with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals` |
| PATCH | `/api/tasks/:id` | `PatchTaskBody` | `TaskView` (400 `DEP_CYCLE` on cycles) |
| POST | `/api/tasks/:id/actions/:action` | `TaskActionBody` | `ActionResponse` |
| POST | `/api/tasks/:id/follow-ups` **+** | `{ text }` | `TaskView` (new Backlog task from a follow-up, with `followUpOf`/`followUpText` set; 409 while a non-discarded task already holds that suggestion) |
| GET | `/api/tasks/:id/diff?view=stat\|full` | | `DiffView` (`patch` only with `view=full`; cut at ~3 MB on a file boundary with `truncated: true`) |
| GET | `/api/tasks/:id/events?after=<id>` | | `EventView[]` |

Actions (`TaskAction`): `start` (`force` to ignore deps) · `move-to-ready` · `move-to-backlog` ·
`resume` (`note`) · `retry-fresh` · `request-changes` (`text`) · `send-message` (`text`) ·
`rerun-review` · `approve` · `update-branch` · `open-pr` · `mark-done` · `discard` ·
`dismiss-finding` (`findingId`) · `choose-design` (`design`: `{ mode: 'build' | 'more', picks:
[{ round, file, note }], notes }`, only in Human Review with reason `design_options`; picks may come
from any round).

Design options **+**: an implement run may end with `"status": "options"` after saving HTML
mock-ups in the design folder its prompt names. The task then goes to Human Review with reason
`design_options` (`approve`, `open-pr` and `rerun-review` are refused until the user picks), the
round is in `TaskDetailView.designRounds` and `TaskView.design`, and `choose-design` sends the
choice back to the thread as a `design` run (build it) or an `options` run (another round).

Action error codes: `ILLEGAL_TRANSITION`, `DEPS_NOT_DONE` (retry with `{ force: true }`;
`details.waitingOn: TaskDepView[]`), `T3_UNAVAILABLE`, `MERGE_CONFLICT` (the task is already
moved to `merge_conflict` when this returns), `NOTHING_TO_MERGE` (branch has no commits ahead of
base), `DIRTY_ROOT`, `DIRTY_WORKTREE`, `START_FAILED`, `GIT_ERROR`. `DEP_CYCLE` on task PATCH
carries `details.cycle` (task ids, first = last).

Reordering: `PATCH /api/tasks/:id { position }` (fractional; put it between neighbours).
Moving Backlog↔Ready is the `move-to-ready` / `move-to-backlog` action (optionally followed by a
position PATCH). Failed → Backlog is `move-to-backlog`.

## Insights

Chats about the board's project. Each chat is one T3 thread on the root checkout (no worktree), started with
`prompts/insight.md` (read-only rules, the board brief, milestones, open tasks, the question) and the planner
model. Follow-up questions go to the same thread as typed. Runs have `kind: 'insight'`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/boards/:id/insights` | | `InsightChatView[]` (most recently active first) |
| POST | `/api/boards/:id/insights` | `{ text }` (the first question) | `InsightChatDetailView` (201) |
| GET | `/api/insights/:id` | | `InsightChatDetailView` (`messages` in order) |
| POST | `/api/insights/:id/messages` | `{ text }` | `InsightChatDetailView` (409 `ILLEGAL_TRANSITION` while the last answer is open) |
| PATCH | `/api/insights/:id` | `{ title }` | `InsightChatView` |
| DELETE | `/api/insights/:id` | | `{ ok: true }` (the T3 thread is kept, and settled when `settleDoneThreads` is on) |

A question adds a `user` message and a `pending` `assistant` message. While the agent works, the
answer's `notes` hold its messages so far; it is `waiting` while the agent waits for the user in T3. When the
run ends, the last assistant message becomes `text`, the earlier ones stay in `notes`, and the status is
`done`, or `failed` with `error` (start failure, a run that ended badly, no reply, or a lost thread). A chat
whose thread is gone continues in a new thread that gets the last 12 messages as context.

The reconciler also watches each chat's thread after its answer (`insight_chats.last_t3_run_id` is the last
T3 run an answer covers). Runs T3 Orchestra didn't start are adopted as `external` insight runs: runs with no
user message (the agent going on by itself, e.g. when its background sub-agents come back) reopen the last
answer, which is then rebuilt from all assistant messages since its question; a message typed in T3 becomes
a new question with its own answer. An answer always stops at the next question.

### Imports from T3 history

`CreateBoardBody.importFromT3: true` (or `POST /api/boards/:id/import`) starts an import; `BoardView.projectImport`
is the latest one (`ProjectImportView`: `{ id, number, status: gathering|running|waiting|done|failed, threadCount,
threadsRead, threadLink, summary, nextSteps, text, error, createdAt, finishedAt }`), so it arrives with every
`board` event. While `gathering`, T3 Orchestra reads the project's threads (`thread list`, then `thread show
--messages 30` for up to 25 of them, 4 at a time); an import left `gathering` by a restart starts over at boot. Then
one read-only T3 thread on the root checkout runs `prompts/import.md` (the digest, the current brief and open
tasks on a re-import) with the planner model; runs have `kind: 'import'`. The result block is `{ summary, about,
state, nextSteps }`; an unusable one gets one correction (`prompts/import-correction.md`), then the import fails.
On success the brief gets a `## Project context (from T3 Code history, <date>)` section: in place of the previous
import's section when the brief still holds it unchanged, else first.

## Ideas

The agent proposes ideas of one category (`code_improvements`, `ui_ux`, `documentation`, `security`,
`performance`, `code_quality`) for the board's project. Each generation (`IdeaBatchView`) is one T3 thread on the
root checkout, started with `prompts/ideas.md` (read-only rules, the category's focus, the board brief, milestones,
open tasks, and the category's earlier ideas so they aren't repeated) and the planner model. Runs have
`kind: 'ideas'`. The agent ends with a `t3orchestra-result` block, `{ summary, ideas: [{ title, description, details,
acceptanceCriteria, touches, impact: high|medium|low, difficulty: easy|medium|hard }] }` (at most 12, none is
fine). An unusable block gets one correction message (`prompts/ideas-correction.md`), then the generation fails.
Exact repeats of the category's earlier titles are dropped.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/boards/:id/ideas` | | `BoardIdeasView`: `batches` (newest first) and the `ideas` that aren't dismissed |
| POST | `/api/boards/:id/ideas` | `{ category }` | `IdeaBatchView` (201; 409 `ILLEGAL_TRANSITION` while that category is generating) |
| POST | `/api/ideas/:id/add` | | `{ idea, task }` (201): a Backlog task (impact → priority, difficulty → complexity small/medium/large); 409 once it is on the board |
| POST | `/api/ideas/:id/dismiss` | `{ undo? }` | `IdeaView` (409 for ideas already on the board) |

A generation is `generating`, `waiting` (the agent waits for the user in T3), `done` (with `ideaCount` and the
agent's `summary`) or `failed` with `error`. A finished generation's thread is settled when `settleDoneThreads`
is on.

## Marketing

The Marketing view has two halves: metrics read from connected sources, and marketing tasks.

**Marketing tasks** are ideas with a marketing category (`launch`, `content`, `seo`, `social`, `growth`,
`analytics`), generated with the same endpoints as Ideas (`POST /api/boards/:id/ideas { category }`) but from
`prompts/marketing.md`, which adds the board's `marketingBrief` (set with `PATCH /api/boards/:id`) and a summary of
its metrics. Each task has a `kind`: `build` (a code change: `POST /api/ideas/:id/add` puts it in the Backlog) or
`do` (done outside the code, usually with copy in `draft`). The result block is `{ summary, suggestedBrief, ideas:
[{ kind, title, description, details, draft, acceptanceCriteria, touches, impact, difficulty }] }`; when the board
has no brief the agent writes one into `suggestedBrief` (shown on the batch, for the user to keep).

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/ideas/:id/done` | `{ undo? }` | `IdeaView` with status `done` (or `new` with `undo`); 409 for `build` tasks |

**Metrics.** A source (`MarketingSourceView`) is one of `github`, `plausible`, `posthog`, `npm`, `pypi`, `docker`,
`hackernews`, `json` (any URL + a dot path to a number) or `manual` (values typed in). `SOURCE_KIND_INFO` in
`packages/shared/src/marketing.ts` lists each kind's fields and metrics. A kind's secret field (token, API key,
header value) is stored on the server and never returned; views carry `hasSecret` instead. Sources are read once
when connected (a failure is a 400 and nothing is saved), on demand, and in the background about every six hours;
every read stores one snapshot per metric. Metric views carry the latest value, a `baseline` about a week back (or
the first value once it is a day old) and one point per UTC day for the last 90 days.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/boards/:id/marketing` | | `BoardMarketingView`: `sources`, and `suggestions` found in the project (GitHub remote, a public npm package) |
| POST | `/api/boards/:id/marketing/sources` | `{ kind, config, secret?, name? }` | `MarketingSourceView` (201); 400 when the first read fails; 409 when already connected |
| POST | `/api/boards/:id/marketing/refresh` | | `MarketingSourceView[]` (every fetched source read now; failures are kept on the source) |
| PATCH | `/api/marketing/sources/:id` | `{ name?, config?, secret? }` | `MarketingSourceView`; leave `secret` out to keep it, `null` removes it. A new target (repo, site, package…) starts the history over |
| DELETE | `/api/marketing/sources/:id` | | `{ ok: true }` (its history too) |
| POST | `/api/marketing/sources/:id/refresh` | | `MarketingSourceView` (`status: 'error'` with `error` when the read failed) |
| POST | `/api/marketing/sources/:id/values` | `{ value }` | `MarketingSourceView` (manual sources only) |

## Security

Audits are agent runs (kind and thread role `security`, read-only on the root checkout, the board's planner
model unless `model` is given), one at a time per board, from `prompts/security-audit.md`; an unusable result
gets one correction (`security-audit-correction.md`). The result block is `{ summary, attackSurface, coverage:
[{ area, status: ok|issues|not_applicable|not_checked, note }], findings: [{ title, severity:
critical|high|medium|low|info, category, file, line, description, details, recommendation, cwe, confidence,
acceptanceCriteria, touches }], resolved: ["S-3"] }`. The prompt lists the open audit findings to re-check
(`resolved` closes them), the scans' findings and the dismissed ones (with their notes), the board brief and
`securityBrief`. A `changes` audit reads `<last finished audit's headSha>..HEAD`.

Scans run in the server: `secrets` (tracked files + the last 300 commits; nothing leaves the machine) and
`dependencies` (lockfiles → OSV.dev `querybatch` + `vulns/:id`). A scan's findings are matched by fingerprint: new
ones are added, ones it no longer sees are fixed (`resolvedBy: 'scan'`), a fixed one it sees again reopens, and a
dismissed dependency reopens when a new advisory appears. Scans interrupted by a restart end `failed`. With
`securityAutoScan`, both run again when the root checkout's HEAD moved (checked every 30 minutes) and at least daily.

Board fields (`PATCH /api/boards/:id`): `securityBrief`, `securityReview` (adds a security checklist to every AI
review; reviewers title those findings "Security: …"), `securityAutoScan`. `BoardView.securityOpen` counts the open
findings per severity.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/boards/:id/security` | | `BoardSecurityView`: `audits` (newest first), `scans` (latest 20), `findings` (most severe first), `reviewFlags` (review findings that read as security issues), `commitsSinceAudit` |
| GET | `/api/boards/:id/security/report` | | `text/markdown` attachment |
| POST | `/api/boards/:id/security/audits` | `{ scope?: full\|changes\|paths, focus?: area[], paths?, instructions?, model? }` | `SecurityAuditView` (201); 409 while one runs, or for `changes` without a finished audit or new commits |
| POST | `/api/boards/:id/security/scans` | `{ kind: secrets\|dependencies }` | `SecurityScanView` (202, `running`; it finishes in the background); 409 while the same kind runs |
| POST | `/api/security/findings/:id/add` | | `{ finding, task }` (201): a Backlog task; 409 when it is on the board already or fixed |
| POST | `/api/security/findings/:id/dismiss` | `{ reason?: false_positive\|accepted_risk\|wont_fix, note?, undo? }` | `SecurityFindingView` |
| POST | `/api/security/findings/:id/fixed` | `{ undo? }` | `SecurityFindingView` (`resolvedBy: 'user'`; with `undo`, open again) |

## Context (knowledge graph)

Context files live in the project at `.t3orchestra/context/files/<name>` (names are cleaned: last path segment, no
`<>:"|?*`, no leading dots, at most 120 characters). Uploading a name the board has (in any case) replaces that
file; new or changed content is `pending` until a build reads it.

`.t3orchestra/context/graph.json` holds the file list (`name`, `size`, `sha256`, `status`, `summary`, `note`) and
the graph (`digest`, `nodes`, `edges`, sources and edges naming files instead of ids) at a revision `updatedAt`
(format `version: 1`). The database keeps a copy, and the folder wins. Before the context is read (the view, a
prompt's knowledge section, `context_search`, a build), a `graph.json` whose revision differs from the copy's
replaces the graph and file list, keeping file ids by name. Files added or changed in `files/` by hand become
`pending`, and deleted ones are taken out (files over 100 MB are left out, and `folderProblem` names them).
Every change made through the API is written back. A `graph.json` that can't be read (invalid JSON, a newer
format) is neither read nor written. An empty folder with files in the database leaves the database as it is.
Files from before (`<dataDir>/context/<boardId>/`) move into the project the first time. Uncommitted changes
under `.t3orchestra/context` don't count as a dirty root checkout for a local merge.

Builds are agent runs (kind and thread role `knowledge`, read-only on the root checkout, the board's planner model),
one at a time per board, from `prompts/knowledge.md`; an unusable result gets one correction
(`knowledge-correction.md`). A build reads up to 12 pending files or 6 MB (at least one file), oldest first; when
it finishes, the next batch starts while files are pending. The result block is `{ summary, digest, files: [{ file,
summary, skipped? }], nodes: [{ key, name, type, summary, aliases, sources: [{ file, where, quote }], code }],
edges: [{ from, to, relation, file? }] }` (lenient: unknown types map to the nearest one, keys are slugged, long
text is cut). T3 Orchestra takes out what the build's files said before (or, for `fresh`, starts from an empty graph),
then adds the result: new nodes need a source in a board file, nodes it already has take the new name, type and
summary and keep their other sources, edges need both ends. Removing a file does the same take-out at once.

Board fields (`PATCH /api/boards/:id`): `contextAutoBuild` (a build starts after uploads; default true),
`contextInPrompts` (prompts get the `{{knowledge}}` section; default true).

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/boards/:id/context` | | `BoardKnowledgeView`: `files` (newest first, with `status`, `reading`, `nodeCount`, `path`, `url`), `builds` (latest 20), `graph` (`nodes`, `edges`, `digest`), `dir` (absolute), `folder` (`.t3orchestra/context`), `folderProblem`, `git` (`{ changes, ignored }` for the folder, or null). Syncs with the folder first and starts a build (with `contextAutoBuild`) when that left new files pending |
| PUT | `/api/boards/:id/context/files?name=` | the file's bytes | `KnowledgeFileView` (201); 413 over 100 MB (the whole body is read first), 409 past 300 files |
| POST | `/api/boards/:id/context/builds` | `{ fresh? }` | `KnowledgeBuildView` (201); 409 while one runs, with no files, or with nothing pending |
| POST | `/api/boards/:id/context/auto-build` | | `{ build: KnowledgeBuildView \| null }`: starts one only when `contextAutoBuild`, files are pending and none runs |
| GET | `/api/boards/:id/context/preview?q=` | | `{ text }`: the knowledge section an agent working on `q` would get |
| GET | `/api/context/files/:id/raw` | | the file: PDFs and raster images as themselves, text (HTML and SVG included) as `text/plain`, the rest as an attachment; `nosniff`, `Content-Security-Policy: sandbox` (not on PDFs) |
| DELETE | `/api/context/files/:id` | | `{ ok: true }` |

## Run project

Starts the project in a board's root checkout, or in a task's worktree, and hands out its local
URL. One run per board root and one per task; starting again replaces the old run. Runs live in
the server's memory (not the DB); a restarted server kills what the old one left running, except
background runs (below), which it lists again.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/boards/:id/run` | | `RunInfoView` (`recipes`: detected ways to run it, best first; the board's saved `config` comes first as `id: "custom"`) |
| POST | `/api/boards/:id/run` | `StartRunBody` | `ProjectRunView` |
| GET | `/api/tasks/:id/run` | | `RunInfoView` for the task's worktree (400 `VALIDATION` without one) |
| POST | `/api/tasks/:id/run` | `StartRunBody` | `ProjectRunView` |
| GET | `/api/project-runs` | | `ProjectRunView[]` (the latest run of every target, live or ended) |
| GET | `/api/project-runs/:id/log` | | `RunLogView` (`{ text, end }`, the last ~200 KB of output) |
| POST | `/api/project-runs/:id/stop` | | `ProjectRunView` (kills the process tree, then runs the recipe's `stop` command; answers once both are done) |
| POST | `/api/project-runs/:id/fix` | `{ note? }` | `FixRunResponse` ("Fix with AI", failed runs only; see below) |

`StartRunBody`: `{}` runs the best recipe · `{ recipeId }` a listed one · `{ config: RunConfig, save? }`
your own command (`save: true` stores it as the board's `runConfig`, also settable with
`PATCH /api/boards/:id { runConfig }`). `RunConfig`: `{ command, mode: 'background' | 'terminal', cwd }`;
`cwd` is relative to the project and must stay inside it. 422 `NOTHING_TO_RUN` when nothing was
detected and no command was given.

Fix with AI renders `prompts/run-fix.md` (how it ran, the error, the last 80 lines of output). For a
task's worktree run in Human Review or Failed, that goes to the task's own thread as `request-changes` /
`send-message` (`created: false`; 409 `ILLEGAL_TRANSITION` while its agent is working). Otherwise (a board
run, or a task that is done) it creates a high-priority `bug` task and starts it (`created: true`;
`startError` is set when the start failed, e.g. T3 is down, and the task waits in the Backlog). Either way
the run's `fixTaskId` points at the task.

Statuses: `starting` (setup steps such as an install) → `running` → `ready` (something answered at
the URL) → `exited` / `failed` / `stopped`. `terminal` mode opens a console window (Windows) or
Terminal.app (macOS) and stays `running` until the window closes. `stopping` is true while Stop works.

A recipe's `stop` is the project's own way to end what it starts: a `stop` / `down` (or `<script>:stop`)
package.json script, the `docker compose … down` matching a script's `docker compose … up`, `docker
compose down` for the Compose recipe, a Makefile `stop` / `down` target, or `stop.bat` / `stop.sh` next to
the run script. Stop runs it (in the recipe's `cwd`, for up to 2 minutes) once the program step has
started; a failure is reported in `error`, with the status still `stopped`. When a command exits with
code 0 but its URL still answers (say, `pnpm dev` ran `docker compose up --detach`) and there is a way to
stop it (a `stop` command, or processes the run left behind), the run stays `ready` with
`background: true` and no `pid`. It is saved to `<dataDir>/background-runs.json`, so a restarted server
lists it again, and it becomes `exited` once the URL stops answering (3 checks, 5 s apart).

## MCP **+**

`POST /mcp`: a read-only MCP server (Streamable HTTP, stateless) for agents in T3 Code
(`apps/server/src/mcp/`). Each JSON-RPC request gets one `application/json` answer; notifications get 202. There is
no session id and no server stream (`GET`/`DELETE /mcp` → 405). Not under `/api`, so no `X-T3Orchestra` header; instead
the body must be `application/json` (415 otherwise) and a browser `Origin` other than localhost gets 403.

Methods: `initialize` (echoes a known protocol version, else the newest; `instructions` say when to use which tool),
`ping`, `tools/list`, `tools/call`. Tools (`board` = name, slug, id or a unique part of a name; optional with one board):

| Tool | Arguments | Returns (text) |
|---|---|---|
| `list_boards` | | one line per board: done of total, running, needing you, auto-run |
| `board_status` | `board?`, `agentMessages?` (default true) | markdown: progress, working on now (with each live agent's latest message, read through `t3 thread show` with a 5 s limit), needs you, up next with hold reasons, milestones, recently done |
| `board_card` | `board?` | a one-line summary, then a self-contained HTML card styled with T3 Code's theme variables, for `html_preview` → `html_render` |
| `task_details` | `board?`, `task` (`54` or `"#54"`) | markdown for one task, discarded ones included |

A board or task that can't be found comes back as a tool result with `isError: true` and a message naming the boards
there are; bad arguments and unknown tools are JSON-RPC errors (-32602).

## Stream

`GET /api/stream` — Server-Sent Events, all boards (client filters by `boardId`).

```
event: task          data: TaskView
event: task_removed  data: { id, boardId }
event: plan          data: PlanView
event: board         data: BoardView
event: health        data: HealthView
event: notify        data: NotifyView
event: settings      data: AppSettings     (after any PATCH /api/settings, e.g. Pause all)
event: project_run     data: ProjectRunView
event: project_run_log data: { id, start, text }   (new output; `start` is its offset, matching RunLogView.end)
event: insight_chat         data: InsightChatView
event: insight_chat_removed data: { id, boardId }
event: insight_message      data: InsightMessageView   (also each time an open answer's notes or status change)
event: idea_batch           data: IdeaBatchView        (each status change)
event: idea                 data: IdeaView             (new, added to the board, dismissed or restored)
event: marketing_source     data: MarketingSourceView  (connected, edited, read or a value logged)
event: marketing_source_removed data: { id, boardId }
event: security_audit       data: SecurityAuditView    (each status change; refetch the view when it ends)
event: security_scan        data: SecurityScanView     (started and finished; refetch the view when it ends)
event: security_finding     data: SecurityFindingView  (added to the board, dismissed, fixed or reopened by the user)
event: knowledge_build      data: KnowledgeBuildView   (each status change; refetch the context view when it ends)
event: knowledge_changed    data: { boardId }          (files or graph changed: refetch the context view)
```

Heartbeat comment every 15s. No replay: on (re)connect the client refetches its queries.
