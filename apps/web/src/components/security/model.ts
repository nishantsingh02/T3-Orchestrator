import {
  SECURITY_CATEGORY_INFO,
  SECURITY_SEVERITY_LABELS,
  type SecurityAuditView,
  type SecurityCategory,
  type SecurityFindingStatus,
  type SecurityFindingView,
  type SecurityScanKind,
  type SecurityScanView,
  type SecuritySeverity,
  type SecuritySource,
} from '@t3-orchestra/shared';
import {
  Bot,
  CircleHelp,
  Database,
  Fingerprint,
  Gauge,
  Globe,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LockKeyhole,
  Package,
  ScanSearch,
  Server,
  Syringe,
  type LucideIcon,
} from 'lucide-react';

/** The view's sections, in the URL as ?section=… and remembered per board. */
export const SECURITY_SECTIONS = ['overview', 'findings', 'audits', 'secrets', 'dependencies'] as const;
export type SecuritySection = (typeof SECURITY_SECTIONS)[number];
export function isSecuritySection(v: string | null | undefined): v is SecuritySection {
  return (SECURITY_SECTIONS as readonly string[]).includes(v ?? '');
}
export const SECTION_INFO: Record<SecuritySection, { label: string; icon: LucideIcon }> = {
  overview: { label: 'Overview', icon: LayoutDashboard },
  findings: { label: 'Findings', icon: ListChecks },
  audits: { label: 'Audits', icon: ScanSearch },
  secrets: { label: 'Secrets', icon: KeyRound },
  dependencies: { label: 'Dependencies', icon: Package },
};

export const SEVERITY_STYLE: Record<SecuritySeverity, { label: string; badge: string; dot: string; text: string }> = {
  critical: { label: SECURITY_SEVERITY_LABELS.critical, badge: 'border-destructive bg-destructive text-destructive-foreground', dot: 'bg-destructive', text: 'text-destructive' },
  high: { label: SECURITY_SEVERITY_LABELS.high, badge: 'border-destructive/35 bg-destructive/12 text-destructive', dot: 'bg-destructive/60', text: 'text-destructive' },
  medium: { label: SECURITY_SEVERITY_LABELS.medium, badge: 'border-warning/35 bg-warning/12 text-warning', dot: 'bg-warning', text: 'text-warning' },
  low: { label: SECURITY_SEVERITY_LABELS.low, badge: 'border-info/30 bg-info/12 text-info', dot: 'bg-info', text: 'text-info' },
  info: { label: SECURITY_SEVERITY_LABELS.info, badge: 'border-border bg-muted text-muted-foreground', dot: 'bg-muted-foreground/50', text: 'text-muted-foreground' },
};

export const CATEGORY_ICONS: Record<SecurityCategory, LucideIcon> = {
  access_control: LockKeyhole,
  injection: Syringe,
  web: Globe,
  secrets: KeyRound,
  data: Database,
  crypto: Fingerprint,
  dependencies: Package,
  infrastructure: Server,
  ai: Bot,
  abuse: Gauge,
  other: CircleHelp,
};
export const categoryLabel = (c: SecurityCategory) => SECURITY_CATEGORY_INFO[c].label;

export const SOURCE_LABELS: Record<SecuritySource, string> = { audit: 'Audit', secrets: 'Secret scan', dependencies: 'Dependency scan' };
export const STATUS_LABELS: Record<SecurityFindingStatus, string> = { open: 'Open', added: 'On the board', fixed: 'Fixed', dismissed: 'Dismissed' };

export const SCOPE_LABELS: Record<SecurityAuditView['scope'], string> = {
  full: 'Full project',
  changes: 'Changes since the last audit',
  paths: 'Selected paths',
};

export const findingLocation = (f: Pick<SecurityFindingView, 'file' | 'line'>) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : null);

export const isAuditOpen = (a: SecurityAuditView | undefined) => a?.status === 'running' || a?.status === 'waiting';

/** The latest scan of a kind (the list comes newest first). */
export const latestScan = (scans: SecurityScanView[] | undefined, kind: SecurityScanKind) => scans?.find((s) => s.kind === kind);

export const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : '');
