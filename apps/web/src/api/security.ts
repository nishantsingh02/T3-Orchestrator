// Security view: queries, mutations and the cache updates SSE pushes go through.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  SECURITY_SEVERITY_RANK,
  type BoardSecurityView,
  type DismissSecurityFindingBody,
  type SecurityAuditView,
  type SecurityFindingView,
  type SecurityScanKind,
  type SecurityScanView,
  type StartAuditInput,
} from '@t3-orchestra/shared';
import type { NavigateFunction } from 'react-router';
import { toast } from 'sonner';
import { applyTask } from './cache';
import { api, errorMessage } from './client';
import { boardSlug } from './ideas';
import { keys } from './keys';

/** Most severe first, then newest. */
export const sortFindings = (list: SecurityFindingView[]) =>
  list.slice().sort((a, b) => SECURITY_SEVERITY_RANK[a.severity] - SECURITY_SEVERITY_RANK[b.severity] || b.number - a.number);

export function applySecurityFinding(qc: QueryClient, f: SecurityFindingView): void {
  qc.setQueryData<BoardSecurityView>(keys.security(f.boardId), (old) => {
    if (!old) return old;
    const known = old.findings.some((x) => x.id === f.id);
    return { ...old, findings: sortFindings(known ? old.findings.map((x) => (x.id === f.id ? f : x)) : [...old.findings, f]) };
  });
}

const onSecurityPage = () => window.location.pathname.endsWith('/security');

function toastTarget(qc: QueryClient, navigate: NavigateFunction, boardId: string, query: string) {
  const slug = boardSlug(qc, boardId);
  return slug ? { label: 'Open', onClick: () => navigate(`/b/${slug}/security?${query}`) } : undefined;
}

/** An audit's progress; a finished one also brings its findings (refetched) and a toast when the view isn't open. */
export function applySecurityAudit(qc: QueryClient, navigate: NavigateFunction, a: SecurityAuditView): void {
  const before = qc.getQueryData<BoardSecurityView>(keys.security(a.boardId))?.audits.find((x) => x.id === a.id);
  qc.setQueryData<BoardSecurityView>(keys.security(a.boardId), (old) => {
    if (!old) return old;
    return { ...old, audits: [a, ...old.audits.filter((x) => x.id !== a.id)].sort((x, y) => y.number - x.number) };
  });
  if ((a.status !== 'done' && a.status !== 'failed') || before?.status === a.status) return;
  void qc.invalidateQueries({ queryKey: keys.security(a.boardId), exact: true });
  if (onSecurityPage()) return;
  const opts = { id: `audit:${a.id}`, duration: 9000, action: toastTarget(qc, navigate, a.boardId, `section=audits&audit=${a.number}`) };
  if (a.status === 'failed') toast.error(`Security audit #${a.number} failed`, { ...opts, description: a.error ?? undefined });
  else if (a.foundCount === 0) toast.success(`Security audit #${a.number}: no new findings`, opts);
  else toast(`Security audit #${a.number}: ${a.foundCount} new finding${a.foundCount === 1 ? '' : 's'}`, opts);
}

/** A scan's progress; a finished one refetches the findings. Scans found nothing new say nothing. */
export function applySecurityScan(qc: QueryClient, navigate: NavigateFunction, s: SecurityScanView): void {
  const before = qc.getQueryData<BoardSecurityView>(keys.security(s.boardId))?.scans.find((x) => x.id === s.id);
  qc.setQueryData<BoardSecurityView>(keys.security(s.boardId), (old) => {
    if (!old) return old;
    return { ...old, scans: [s, ...old.scans.filter((x) => x.id !== s.id)].sort((x, y) => y.createdAt.localeCompare(x.createdAt)) };
  });
  if (s.status === 'running' || before?.status === s.status) return;
  void qc.invalidateQueries({ queryKey: keys.security(s.boardId), exact: true });
  if (onSecurityPage()) return;
  const label = s.kind === 'secrets' ? 'Secret scan' : 'Dependency scan';
  const opts = { id: `scan:${s.id}`, duration: 9000, action: toastTarget(qc, navigate, s.boardId, `section=${s.kind}`) };
  if (s.status === 'failed') toast.error(`${label} failed`, { ...opts, description: s.error ?? undefined });
  else if (s.newCount > 0) toast(`${label}: ${s.newCount} new finding${s.newCount === 1 ? '' : 's'}`, opts);
}

export function useSecurity(boardId: string | undefined) {
  return useQuery({
    queryKey: keys.security(boardId ?? ''),
    queryFn: () => api.security(boardId as string),
    enabled: Boolean(boardId),
  });
}

/** Errors are left to the caller (the dialog shows them). */
export function useStartAudit(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StartAuditInput) => api.startAudit(boardId, body),
    onSuccess: (audit) =>
      qc.setQueryData<BoardSecurityView>(keys.security(boardId), (old) =>
        old ? { ...old, audits: [audit, ...old.audits.filter((x) => x.id !== audit.id)] } : old,
      ),
  });
}

export function useStartScan(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: SecurityScanKind) => api.startScan(boardId, kind),
    onSuccess: (scan) =>
      qc.setQueryData<BoardSecurityView>(keys.security(boardId), (old) => (old ? { ...old, scans: [scan, ...old.scans.filter((x) => x.id !== scan.id)] } : old)),
    onError: (err) => toast.error('Could not start the scan', { description: errorMessage(err) }),
  });
}

export function useAddFinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (f: SecurityFindingView) => api.addFinding(f.id),
    onSuccess: ({ finding, task }) => {
      applySecurityFinding(qc, finding);
      applyTask(qc, task);
    },
    onError: (err) => toast.error('Could not add the finding to the board', { description: errorMessage(err) }),
  });
}

/** Dismisses a finding (or brings it back with `undo`), optimistically. */
export function useDismissFinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ finding, ...body }: { finding: SecurityFindingView } & Partial<DismissSecurityFindingBody>) => api.dismissFinding(finding.id, body),
    onMutate: ({ finding, undo, reason, note }) =>
      applySecurityFinding(qc, undo ? finding : { ...finding, status: 'dismissed', dismissReason: reason ?? 'false_positive', dismissNote: note ?? '' }),
    onSuccess: (f) => applySecurityFinding(qc, f),
    onError: (err, { finding }) => {
      applySecurityFinding(qc, finding);
      toast.error('Could not update the finding', { description: errorMessage(err) });
    },
  });
}

/** Marks a finding fixed (or open again with `undo`), optimistically. */
export function useMarkFindingFixed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ finding, undo }: { finding: SecurityFindingView; undo: boolean }) => api.markFindingFixed(finding.id, undo),
    onMutate: ({ finding, undo }) => {
      if (!undo) applySecurityFinding(qc, { ...finding, status: 'fixed', resolvedBy: 'user', resolvedAt: new Date().toISOString() });
    },
    onSuccess: (f) => applySecurityFinding(qc, f),
    onError: (err, { finding }) => {
      applySecurityFinding(qc, finding);
      toast.error('Could not update the finding', { description: errorMessage(err) });
    },
  });
}
