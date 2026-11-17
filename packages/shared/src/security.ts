// Security view: audits by a read-only agent, a local secret scan, a dependency check against
// OSV.dev, and the findings they produce (with their way to the board as tasks).
import { z } from 'zod';
import type { FindingStatus, Severity, Stage } from './enums.ts';

export const SECURITY_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];
/** Lower is more severe. */
export const SECURITY_SEVERITY_RANK: Record<SecuritySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
export const SECURITY_SEVERITY_LABELS: Record<SecuritySeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

/** What an audit can focus on; also the category of a finding (plus `other`). */
export const SECURITY_AREAS = [
  'access_control',
  'injection',
  'web',
  'secrets',
  'data',
  'crypto',
  'dependencies',
  'infrastructure',
  'ai',
  'abuse',
] as const;
export type SecurityArea = (typeof SECURITY_AREAS)[number];
export const SECURITY_CATEGORIES = [...SECURITY_AREAS, 'other'] as const;
export type SecurityCategory = (typeof SECURITY_CATEGORIES)[number];
export const SECURITY_CATEGORY_INFO: Record<SecurityCategory, { label: string; blurb: string }> = {
  access_control: { label: 'Auth & access control', blurb: 'Who can do what: missing checks, one user reaching another’s data, sessions and tokens.' },
  injection: { label: 'Injection & input', blurb: 'Untrusted input reaching SQL, shell commands, file paths, templates or outgoing requests.' },
  web: { label: 'Web & browser', blurb: 'XSS, CSRF, CORS, cookies, security headers and open redirects.' },
  secrets: { label: 'Secrets & credentials', blurb: 'Keys and passwords in the code, config, logs or the client bundle.' },
  data: { label: 'Sensitive data', blurb: 'Personal data and tokens in logs, errors and over-broad API responses.' },
  crypto: { label: 'Cryptography', blurb: 'Weak password hashing, predictable tokens, disabled TLS checks, JWT pitfalls.' },
  dependencies: { label: 'Dependencies', blurb: 'Vulnerable packages, and how dependencies come in: pinning, install scripts, CI actions.' },
  infrastructure: { label: 'Config & infrastructure', blurb: 'Debug modes, Dockerfiles, exposed ports, CI workflows and deployment config.' },
  ai: { label: 'AI & agents', blurb: 'Prompt injection reaching tools, model output used unchecked, keys and cost limits.' },
  abuse: { label: 'Abuse & logic', blurb: 'Missing rate limits, unbounded work a user can trigger, race conditions, logic flaws.' },
  other: { label: 'Other', blurb: 'Everything else.' },
};

/** Where a finding came from. */
export const SECURITY_SOURCES = ['audit', 'secrets', 'dependencies'] as const;
export type SecuritySource = (typeof SECURITY_SOURCES)[number];

/** `added`: it is a task on the board; `fixed`: a later audit or scan no longer sees it, or the user said so. */
export const SECURITY_FINDING_STATUSES = ['open', 'added', 'fixed', 'dismissed'] as const;
export type SecurityFindingStatus = (typeof SECURITY_FINDING_STATUSES)[number];
export const SECURITY_DISMISS_REASONS = ['false_positive', 'accepted_risk', 'wont_fix'] as const;
export type SecurityDismissReason = (typeof SECURITY_DISMISS_REASONS)[number];
export const SECURITY_DISMISS_LABELS: Record<SecurityDismissReason, string> = {
  false_positive: 'False positive',
  accepted_risk: 'Accepted risk',
  wont_fix: "Won't fix",
};
export type SecurityResolvedBy = 'audit' | 'scan' | 'user';
export const SECURITY_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type SecurityConfidence = (typeof SECURITY_CONFIDENCES)[number];

/** `full`: the whole project; `changes`: commits since the last finished audit; `paths`: only the paths given. */
export const SECURITY_AUDIT_SCOPES = ['full', 'changes', 'paths'] as const;
export type SecurityAuditScope = (typeof SECURITY_AUDIT_SCOPES)[number];
/** `waiting`: the agent asks for something in T3. */
export const SECURITY_AUDIT_STATUSES = ['running', 'waiting', 'done', 'failed'] as const;
export type SecurityAuditStatus = (typeof SECURITY_AUDIT_STATUSES)[number];

export const SECURITY_SCAN_KINDS = ['secrets', 'dependencies'] as const;
export type SecurityScanKind = (typeof SECURITY_SCAN_KINDS)[number];
export const SECURITY_SCAN_STATUSES = ['running', 'done', 'failed'] as const;
export type SecurityScanStatus = (typeof SECURITY_SCAN_STATUSES)[number];

/** "S-12": how findings are named to the user and to the audit agent. */
export const findingRef = (number: number) => `S-${number}`;

// ---------------------------------------------------------------------------
// Audit result block
// ---------------------------------------------------------------------------

export const MAX_AUDIT_FINDINGS = 30;

export const AuditFinding = z.object({
  title: z.string().trim().min(3).max(140),
  severity: z.enum(SECURITY_SEVERITIES),
  category: z.enum(SECURITY_CATEGORIES).catch('other'),
  file: z.string().trim().max(400).nullish().catch(null),
  line: z.number().int().positive().nullish().catch(null),
  /** One or two sentences for the card. */
  description: z.string().trim().min(1),
  /** Markdown: the evidence (code), how an attacker reaches it, what they gain. */
  details: z.string().default(''),
  /** Markdown: how to fix it. */
  recommendation: z.string().default(''),
  cwe: z
    .string()
    .trim()
    .regex(/^CWE-\d+$/i)
    .nullish()
    .catch(null),
  confidence: z.enum(SECURITY_CONFIDENCES).catch('medium'),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  touches: z.array(z.string()).default([]),
});
export type AuditFinding = z.infer<typeof AuditFinding>;

export const AUDIT_COVERAGE_STATUSES = ['ok', 'issues', 'not_applicable', 'not_checked'] as const;
export type AuditCoverageStatus = (typeof AUDIT_COVERAGE_STATUSES)[number];
export const AuditCoverage = z.object({
  area: z.string().trim().min(1).max(80),
  status: z.enum(AUDIT_COVERAGE_STATUSES).catch('not_checked'),
  note: z.string().default(''),
});
export type AuditCoverage = z.infer<typeof AuditCoverage>;

export const AuditResult = z.object({
  /** Markdown, a short paragraph: the overall state and what matters most. */
  summary: z.string().trim().min(1),
  /** Markdown: entry points, trust boundaries, sensitive data, how auth works. */
  attackSurface: z.string().default(''),
  coverage: z.array(AuditCoverage).max(30).default([]),
  findings: z.array(AuditFinding).max(MAX_AUDIT_FINDINGS),
  /** References ("S-3") of earlier audit findings the agent checked and found fixed. */
  resolved: z.array(z.string()).default([]),
});
export type AuditResult = z.infer<typeof AuditResult>;

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/** POST /api/boards/:id/security/audits */
export const StartAuditBody = z
  .object({
    scope: z.enum(SECURITY_AUDIT_SCOPES).default('full'),
    /** Empty: every area. */
    focus: z.array(z.enum(SECURITY_AREAS)).max(SECURITY_AREAS.length).default([]),
    paths: z.array(z.string().trim().min(1).max(400)).max(50).default([]),
    instructions: z.string().trim().max(10_000).default(''),
    /** The model for this audit; the board's planner model when left out. */
    model: z.string().trim().min(1).nullish(),
  })
  .refine((b) => b.scope !== 'paths' || b.paths.length > 0, { message: 'name at least one path', path: ['paths'] });
export type StartAuditBody = z.infer<typeof StartAuditBody>;
export type StartAuditInput = z.input<typeof StartAuditBody>;

/** POST /api/boards/:id/security/scans */
export const StartScanBody = z.object({ kind: z.enum(SECURITY_SCAN_KINDS) });
export type StartScanBody = z.infer<typeof StartScanBody>;

/** POST /api/security/findings/:id/dismiss; `undo` brings it back. */
export const DismissSecurityFindingBody = z.object({
  reason: z.enum(SECURITY_DISMISS_REASONS).default('false_positive'),
  note: z.string().trim().max(2000).default(''),
  undo: z.boolean().default(false),
});
export type DismissSecurityFindingBody = z.infer<typeof DismissSecurityFindingBody>;

/** POST /api/security/findings/:id/fixed; `undo` opens it again. */
export const MarkFindingFixedBody = z.object({ undo: z.boolean().default(false) });
export type MarkFindingFixedBody = z.infer<typeof MarkFindingFixedBody>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface DependencyAdvisory {
  id: string;
  /** CVE ids and the like. */
  aliases: string[];
  summary: string;
  severity: SecuritySeverity;
  /** The lowest version above the installed one that fixes it; null when there is none yet. */
  fixed: string | null;
  url: string;
}

export interface SecretLocation {
  file: string;
  line: number;
  /** Set when the secret is only in an older commit. */
  commit: string | null;
}

export type SecurityFindingMeta =
  | { kind: 'audit' }
  | {
      kind: 'dependency';
      ecosystem: string;
      name: string;
      versions: string[];
      lockfiles: string[];
      /** The version that fixes every advisory, when there is one. */
      fixedIn: string | null;
      advisories: DependencyAdvisory[];
    }
  | {
      kind: 'secret';
      rule: string;
      /** The first characters only; the secret itself is never stored. */
      preview: string;
      /** Removed from the code, but still in an older commit. */
      inHistoryOnly: boolean;
      locations: SecretLocation[];
    };

export interface SecurityFindingView {
  id: string;
  boardId: string;
  number: number;
  source: SecuritySource;
  /** The audit that first reported it. */
  auditId: string | null;
  auditNumber: number | null;
  severity: SecuritySeverity;
  category: SecurityCategory;
  title: string;
  description: string;
  details: string;
  recommendation: string;
  file: string | null;
  line: number | null;
  cwe: string | null;
  confidence: SecurityConfidence;
  acceptanceCriteria: string[];
  touches: string[];
  meta: SecurityFindingMeta;
  status: SecurityFindingStatus;
  dismissReason: SecurityDismissReason | null;
  dismissNote: string;
  /** The task "Add to board" made. */
  taskId: string | null;
  taskNumber: number | null;
  taskStage: Stage | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolvedBy: SecurityResolvedBy | null;
  /** The audit that found it fixed. */
  resolvedAuditNumber: number | null;
  updatedAt: string;
}

export interface SecurityAuditView {
  id: string;
  boardId: string;
  number: number;
  scope: SecurityAuditScope;
  focus: SecurityArea[];
  paths: string[];
  instructions: string;
  /** `changes` audits: the commit of the audit before. */
  baseSha: string | null;
  /** The commit the agent read. */
  headSha: string | null;
  status: SecurityAuditStatus;
  threadLink: string | null;
  summary: string | null;
  attackSurface: string | null;
  coverage: AuditCoverage[];
  /** Findings it reported first. */
  foundCount: number;
  /** Earlier findings it checked and found fixed. */
  resolvedCount: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface SecurityScanStats {
  /** Secrets: tracked files read, and commits whose changes were read. */
  files?: number;
  commits?: number;
  /** Dependencies: the lockfiles read, the packages in them, and how many have advisories. */
  lockfiles?: string[];
  packages?: number;
  ecosystems?: string[];
  vulnerable?: number;
  /** Something the scan could not do, said plainly ("git history was too large to read"). */
  notes?: string[];
}

export interface SecurityScanView {
  id: string;
  boardId: string;
  kind: SecurityScanKind;
  status: SecurityScanStatus;
  headSha: string | null;
  stats: SecurityScanStats;
  /** Findings it reported for the first time, and earlier ones it no longer saw. */
  newCount: number;
  fixedCount: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** A finding an AI reviewer flagged as a security issue while reviewing a task. */
export interface SecurityReviewFlagView {
  id: string;
  taskId: string;
  taskNumber: number;
  taskTitle: string;
  taskStage: Stage;
  round: number;
  severity: Severity;
  title: string;
  file: string | null;
  line: number | null;
  status: FindingStatus;
}

/** GET /api/boards/:id/security */
export interface BoardSecurityView {
  /** Newest first. */
  audits: SecurityAuditView[];
  /** The latest scans of each kind, newest first. */
  scans: SecurityScanView[];
  /** Every finding, most severe first. */
  findings: SecurityFindingView[];
  /** Newest first. */
  reviewFlags: SecurityReviewFlagView[];
  /** Commits in the root checkout since the last finished audit; null without one (or when git can't tell). */
  commitsSinceAudit: number | null;
}

/** Open findings (not yet on the board, fixed or dismissed) by severity, for the board's tab badge. */
export type SecurityOpenCounts = Record<SecuritySeverity, number>;
