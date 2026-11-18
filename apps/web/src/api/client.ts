// Typed fetch wrapper for the T3 Orchestra REST API (docs/api.md).
import type {
  ActionResponse,
  AddSuggestionsBody,
  AnyIdeaCategory,
  ApiError as ApiErrorBody,
  AppSettings,
  BoardIdeasView,
  BoardKnowledgeView,
  BoardMarketingView,
  BoardSecurityView,
  BoardStatsView,
  BoardView,
  CreateBoardBody,
  CreateMarketingSourceBody,
  CreateMilestoneBody,
  CreatePlanBody,
  CreateTaskBody,
  DiffView,
  DismissSecurityFindingBody,
  DismissSuggestionsBody,
  ErrorCode,
  EventView,
  FixRunBody,
  FixRunResponse,
  GithubAccountView,
  HealthView,
  IdeaBatchView,
  IdeaView,
  InsightChatDetailView,
  InsightChatView,
  KnowledgeBuildView,
  KnowledgeFileView,
  MarketingSourceView,
  MilestoneView,
  NewFolderCheck,
  PatchBoardBody,
  PatchMarketingSourceBody,
  PatchMilestoneBody,
  PatchSettings,
  PatchTaskBody,
  PickFolderBody,
  PickFolderResult,
  PlanDetailView,
  PlanTask,
  PlanView,
  ProjectRunView,
  ProjectSetupResult,
  ProposalPatch,
  PlanFromSpecInput,
  RefinePlanInput,
  RunInfoView,
  RunLogView,
  SecurityAuditView,
  SecurityFindingView,
  SecurityScanKind,
  SecurityScanView,
  SetupProjectBody,
  StartAuditInput,
  StartRunBody,
  SuggestionView,
  T3ModelCatalogView,
  T3ProjectView,
  TaskAction,
  TaskActionBody,
  TaskDetailView,
  TaskView,
  UpdateContextFileBody,
} from '@t3-orchestra/shared';
import type { ProjectValidation, SettingsInfo } from './types';

export type ClientErrorCode = ErrorCode | 'NETWORK' | 'HTTP';

/** Every failed API call throws this. `code` is the server's error code when it sent one. */
export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ClientErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isApiError(e: unknown, code?: ClientErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

/** Readable message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isErrorBody(v: unknown): v is { ok: false; error: ApiErrorBody } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { ok?: unknown }).ok === false &&
    typeof (v as { error?: unknown }).error === 'object' &&
    (v as { error?: unknown }).error !== null
  );
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** `body` goes as JSON, a Blob as is (file uploads). */
async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-T3Orchestra'] = '1';
  const raw = body instanceof Blob;
  if (body !== undefined) headers['Content-Type'] = raw ? 'application/octet-stream' : 'application/json';

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach the T3 Orchestra server.', 0);
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (isErrorBody(data)) {
    const err = data.error;
    throw new ApiError(err.code ?? 'HTTP', err.message || `${res.status} ${res.statusText}`, res.status, err.details);
  }
  if (!res.ok) {
    const snippet = text && data === undefined ? `: ${text.slice(0, 200)}` : '';
    throw new ApiError('HTTP', `${res.status} ${res.statusText}${snippet}`, res.status);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);
const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body);
const del = <T>(path: string) => request<T>('DELETE', path);

const enc = encodeURIComponent;

export const api = {
  // Health & settings
  health: () => get<HealthView>('/api/health'),
  settings: () => get<AppSettings>('/api/settings'),
  patchSettings: (body: PatchSettings) => patch<AppSettings>('/api/settings', body),
  settingsInfo: () => get<SettingsInfo>('/api/settings/info'),
  testConnection: () => post<HealthView>('/api/settings/test-connection'),
  t3Models: () => get<T3ModelCatalogView>('/api/t3/models'),
  t3Projects: () => get<T3ProjectView[]>('/api/t3/projects'),
  openPromptsDir: () => post<{ ok: true }>('/api/settings/open-prompts-dir'),

  // Boards
  validateProject: (body: { projectPath: string; baseBranch?: string }) =>
    post<ProjectValidation>('/api/validate-project', body),
  addToT3: (body: { projectPath: string }) => post<ProjectValidation>('/api/add-to-t3', body),
  /** Waits until the user closes the folder window on the computer running T3 Orchestra. */
  pickFolder: (body: PickFolderBody) => post<PickFolderResult>('/api/folders/pick', body),
  checkNewFolder: (body: { parent: string; name: string }) => post<NewFolderCheck>('/api/folders/check-new', body),
  githubAccount: (refresh = false) => get<GithubAccountView>(`/api/github/account${refresh ? '?refresh=1' : ''}`),
  setupProject: (body: SetupProjectBody) => post<ProjectSetupResult>('/api/projects/setup', body),
  boards: () => get<BoardView[]>('/api/boards'),
  board: (idOrSlug: string) => get<BoardView>(`/api/boards/${enc(idOrSlug)}`),
  createBoard: (body: CreateBoardBody) => post<BoardView>('/api/boards', body),
  patchBoard: (id: string, body: PatchBoardBody) => patch<BoardView>(`/api/boards/${enc(id)}`, body),
  archiveBoard: (id: string) => del<{ ok: true }>(`/api/boards/${enc(id)}`),
  validateBoardProject: (id: string) => post<ProjectValidation>(`/api/boards/${enc(id)}/validate-project`),
  importFromT3: (id: string) => post<BoardView>(`/api/boards/${enc(id)}/import`),
  addBoardToT3: (id: string) => post<ProjectValidation>(`/api/boards/${enc(id)}/add-to-t3`),
  boardExportUrl: (id: string) => `/api/boards/${enc(id)}/export`,
  boardStats: (id: string) => get<BoardStatsView>(`/api/boards/${enc(id)}/stats`),

  // milestones & suggestions
  milestones: (boardId: string) => get<MilestoneView[]>(`/api/boards/${enc(boardId)}/milestones`),
  createMilestone: (boardId: string, body: CreateMilestoneBody) =>
    post<MilestoneView>(`/api/boards/${enc(boardId)}/milestones`, body),
  patchMilestone: (id: string, body: PatchMilestoneBody) => patch<MilestoneView>(`/api/milestones/${enc(id)}`, body),
  deleteMilestone: (id: string) => del<{ ok: true }>(`/api/milestones/${enc(id)}`),
  suggestions: (boardId: string) => get<SuggestionView[]>(`/api/boards/${enc(boardId)}/suggestions`),
  addSuggestions: (boardId: string, body: AddSuggestionsBody) =>
    post<TaskView[]>(`/api/boards/${enc(boardId)}/suggestions/add`, body),
  dismissSuggestions: (boardId: string, body: DismissSuggestionsBody) =>
    post<{ ok: true }>(`/api/boards/${enc(boardId)}/suggestions/dismiss`, body),

  // Insights
  insightChats: (boardId: string) => get<InsightChatView[]>(`/api/boards/${enc(boardId)}/insights`),
  createInsightChat: (boardId: string, text: string) =>
    post<InsightChatDetailView>(`/api/boards/${enc(boardId)}/insights`, { text }),
  insightChat: (id: string) => get<InsightChatDetailView>(`/api/insights/${enc(id)}`),
  sendInsightMessage: (id: string, text: string) => post<InsightChatDetailView>(`/api/insights/${enc(id)}/messages`, { text }),
  renameInsightChat: (id: string, title: string) => patch<InsightChatView>(`/api/insights/${enc(id)}`, { title }),
  deleteInsightChat: (id: string) => del<{ ok: true }>(`/api/insights/${enc(id)}`),

  // Ideas
  ideas: (boardId: string) => get<BoardIdeasView>(`/api/boards/${enc(boardId)}/ideas`),
  generateIdeas: (boardId: string, category: AnyIdeaCategory) => post<IdeaBatchView>(`/api/boards/${enc(boardId)}/ideas`, { category }),
  addIdea: (id: string) => post<{ idea: IdeaView; task: TaskView }>(`/api/ideas/${enc(id)}/add`),
  dismissIdea: (id: string, undo = false) => post<IdeaView>(`/api/ideas/${enc(id)}/dismiss`, { undo }),
  markIdeaDone: (id: string, undo = false) => post<IdeaView>(`/api/ideas/${enc(id)}/done`, { undo }),

  // Marketing metrics
  marketing: (boardId: string) => get<BoardMarketingView>(`/api/boards/${enc(boardId)}/marketing`),
  addMarketingSource: (boardId: string, body: CreateMarketingSourceBody) =>
    post<MarketingSourceView>(`/api/boards/${enc(boardId)}/marketing/sources`, body),
  refreshMarketing: (boardId: string) => post<MarketingSourceView[]>(`/api/boards/${enc(boardId)}/marketing/refresh`),
  patchMarketingSource: (id: string, body: PatchMarketingSourceBody) => patch<MarketingSourceView>(`/api/marketing/sources/${enc(id)}`, body),
  removeMarketingSource: (id: string) => del<{ ok: true }>(`/api/marketing/sources/${enc(id)}`),
  refreshMarketingSource: (id: string) => post<MarketingSourceView>(`/api/marketing/sources/${enc(id)}/refresh`),
  logMetricValue: (id: string, value: number) => post<MarketingSourceView>(`/api/marketing/sources/${enc(id)}/values`, { value }),

  // Security
  security: (boardId: string) => get<BoardSecurityView>(`/api/boards/${enc(boardId)}/security`),
  /** A plain link: the report downloads as a Markdown file. */
  securityReportUrl: (boardId: string) => `/api/boards/${enc(boardId)}/security/report`,
  startAudit: (boardId: string, body: StartAuditInput) => post<SecurityAuditView>(`/api/boards/${enc(boardId)}/security/audits`, body),
  startScan: (boardId: string, kind: SecurityScanKind) => post<SecurityScanView>(`/api/boards/${enc(boardId)}/security/scans`, { kind }),
  addFinding: (id: string) => post<{ finding: SecurityFindingView; task: TaskView }>(`/api/security/findings/${enc(id)}/add`),
  dismissFinding: (id: string, body: Partial<DismissSecurityFindingBody>) => post<SecurityFindingView>(`/api/security/findings/${enc(id)}/dismiss`, body),
  markFindingFixed: (id: string, undo = false) => post<SecurityFindingView>(`/api/security/findings/${enc(id)}/fixed`, { undo }),

  // Context files and the knowledge graph
  knowledge: (boardId: string) => get<BoardKnowledgeView>(`/api/boards/${enc(boardId)}/context`),
  /** `description` left out keeps the one a file with that name has; empty clears it. */
  uploadContextFile: (boardId: string, name: string, data: Blob, description?: string) =>
    put<KnowledgeFileView>(
      `/api/boards/${enc(boardId)}/context/files?name=${enc(name)}${description === undefined ? '' : `&description=${enc(description)}`}`,
      data,
    ),
  updateContextFile: (id: string, body: UpdateContextFileBody) => patch<KnowledgeFileView>(`/api/context/files/${enc(id)}`, body),
  removeContextFile: (id: string) => del<{ ok: true }>(`/api/context/files/${enc(id)}`),
  startKnowledgeBuild: (boardId: string, fresh = false) => post<KnowledgeBuildView>(`/api/boards/${enc(boardId)}/context/builds`, { fresh }),
  /** Starts a build when the board reads new files on its own and none is running. */
  autoBuildKnowledge: (boardId: string) => post<{ build: KnowledgeBuildView | null }>(`/api/boards/${enc(boardId)}/context/auto-build`),
  knowledgePreview: (boardId: string, q: string) => get<{ text: string }>(`/api/boards/${enc(boardId)}/context/preview?q=${enc(q)}`),

  // Plans
  boardPlans: (boardId: string) => get<PlanView[]>(`/api/boards/${enc(boardId)}/plans`),
  createPlan: (boardId: string, body: CreatePlanBody) => post<PlanView>(`/api/boards/${enc(boardId)}/plans`, body),
  plan: (id: string) => get<PlanDetailView>(`/api/plans/${enc(id)}`),
  patchProposal: (planId: string, key: string, body: ProposalPatch) =>
    patch<PlanDetailView>(`/api/plans/${enc(planId)}/proposals/${enc(key)}`, body),
  addProposal: (planId: string, body: PlanTask) => post<PlanDetailView>(`/api/plans/${enc(planId)}/proposals`, body),
  deleteProposal: (planId: string, key: string) =>
    del<PlanDetailView>(`/api/plans/${enc(planId)}/proposals/${enc(key)}`),
  replaceProposals: (planId: string, tasks: PlanTask[]) =>
    put<PlanDetailView>(`/api/plans/${enc(planId)}/proposals`, { tasks }),
  refinePlan: (planId: string, body: RefinePlanInput) => post<PlanView>(`/api/plans/${enc(planId)}/refine`, body),
  editSpec: (planId: string, spec: string) => put<PlanDetailView>(`/api/plans/${enc(planId)}/spec`, { spec }),
  refineSpec: (planId: string, body: RefinePlanInput) => post<PlanView>(`/api/plans/${enc(planId)}/spec/refine`, body),
  planFromSpec: (planId: string, body: PlanFromSpecInput) => post<PlanView>(`/api/plans/${enc(planId)}/spec/plan`, body),
  acceptPlan: (planId: string, keys?: string[]) =>
    post<{ plan: PlanView; tasks: TaskView[] }>(`/api/plans/${enc(planId)}/accept`, keys ? { keys } : {}),
  discardPlan: (planId: string) => post<PlanView>(`/api/plans/${enc(planId)}/discard`),
  retryPlan: (planId: string) => post<PlanView>(`/api/plans/${enc(planId)}/retry`),

  // Tasks
  boardTasks: (boardId: string) => get<TaskView[]>(`/api/boards/${enc(boardId)}/tasks?discarded=1`),
  createTask: (boardId: string, body: CreateTaskBody) => post<TaskView>(`/api/boards/${enc(boardId)}/tasks`, body),
  task: (id: string) => get<TaskDetailView>(`/api/tasks/${enc(id)}`),
  patchTask: (id: string, body: PatchTaskBody) => patch<TaskView>(`/api/tasks/${enc(id)}`, body),
  taskAction: async (id: string, action: TaskAction, body: TaskActionBody = {}): Promise<TaskView> => {
    const res = await post<ActionResponse>(`/api/tasks/${enc(id)}/actions/${enc(action)}`, body);
    if (!res.ok) throw new ApiError(res.error.code, res.error.message, 200, res.error.details);
    return res.task;
  },
  addFollowUp: (id: string, text: string) => post<TaskView>(`/api/tasks/${enc(id)}/follow-ups`, { text }),
  taskDiff: (id: string, view: 'stat' | 'full') => get<DiffView>(`/api/tasks/${enc(id)}/diff?view=${view}`),
  taskEvents: (id: string, after?: number) =>
    get<EventView[]>(`/api/tasks/${enc(id)}/events${after !== undefined ? `?after=${after}` : ''}`),

  // Run project (a board's root checkout, or a task's worktree)
  runInfo: (t: RunTarget) => get<RunInfoView>(runPath(t)),
  startRun: (t: RunTarget, body: StartRunBody = {}) => post<ProjectRunView>(runPath(t), body),
  projectRuns: () => get<ProjectRunView[]>('/api/project-runs'),
  projectRunLog: (id: string) => get<RunLogView>(`/api/project-runs/${enc(id)}/log`),
  stopProjectRun: (id: string) => post<ProjectRunView>(`/api/project-runs/${enc(id)}/stop`),
  fixProjectRun: (id: string, body: FixRunBody = {}) => post<FixRunResponse>(`/api/project-runs/${enc(id)}/fix`, body),
  openInVsCode: (t: RunTarget) => post<{ dir: string }>(`${targetPath(t)}/open-in-vscode`),
  boardGithub: (boardId: string) => get<{ url: string | null }>(`/api/boards/${enc(boardId)}/github`),
};

export interface RunTarget {
  boardId: string;
  taskId: string | null;
}

const targetPath = (t: RunTarget) => (t.taskId ? `/api/tasks/${enc(t.taskId)}` : `/api/boards/${enc(t.boardId)}`);
const runPath = (t: RunTarget) => `${targetPath(t)}/run`;
