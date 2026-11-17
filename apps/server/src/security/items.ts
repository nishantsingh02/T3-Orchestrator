import type { SecurityCategory, SecurityConfidence, SecurityFindingMeta, SecuritySeverity } from '@t3-orchestra/shared';

/** A finding as a scan or an audit reports it, before it is matched against the board's findings. */
export interface ScanItem {
  /** Same problem, same fingerprint: how a later scan recognizes it. */
  fingerprint: string;
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
}
