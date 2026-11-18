// Context view: the board's context files and knowledge graph, the uploads and builds, and the cache
// updates SSE pushes go through.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { MAX_KNOWLEDGE_FILE_BYTES, MAX_KNOWLEDGE_FILE_MB, type BoardKnowledgeView, type KnowledgeBuildView, type KnowledgeFileView } from '@t3-orchestra/shared';
import type { NavigateFunction } from 'react-router';
import { toast } from 'sonner';
import { api, errorMessage } from './client';
import { boardSlug } from './ideas';
import { keys } from './keys';

export const isBuildOpen = (b: KnowledgeBuildView | undefined) => b?.status === 'running' || b?.status === 'waiting';

const onContextPage = () => window.location.pathname.endsWith('/context');

function statsText(b: KnowledgeBuildView): string {
  const s = b.stats;
  if (!s) return '';
  const parts = [s.added && `${s.added} new`, s.updated && `${s.updated} updated`, s.removed && `${s.removed} removed`].filter(Boolean);
  return parts.length ? `${parts.join(', ')} node${s.added + s.updated + s.removed === 1 ? '' : 's'}` : 'nothing new';
}

/** A build's progress; a finished one refetches the graph, with a toast when the view isn't open. */
export function applyKnowledgeBuild(qc: QueryClient, navigate: NavigateFunction, b: KnowledgeBuildView): void {
  const before = qc.getQueryData<BoardKnowledgeView>(keys.knowledge(b.boardId))?.builds.find((x) => x.id === b.id);
  qc.setQueryData<BoardKnowledgeView>(keys.knowledge(b.boardId), (old) =>
    old ? { ...old, builds: [b, ...old.builds.filter((x) => x.id !== b.id)].sort((x, y) => y.number - x.number) } : old,
  );
  if ((b.status !== 'done' && b.status !== 'failed') || before?.status === b.status) return;
  void qc.invalidateQueries({ queryKey: keys.knowledge(b.boardId), exact: true });
  if (onContextPage()) return;
  const slug = boardSlug(qc, b.boardId);
  const opts = { id: `knowledge:${b.id}`, duration: 9000, action: slug ? { label: 'Open', onClick: () => navigate(`/b/${slug}/context`) } : undefined };
  if (b.status === 'failed') toast.error(`Knowledge graph build #${b.number} failed`, { ...opts, description: b.error ?? undefined });
  else toast.success(`Knowledge graph updated: ${statsText(b)}`, { ...opts, description: b.summary ?? undefined });
}

export function invalidateKnowledge(qc: QueryClient, boardId: string): void {
  void qc.invalidateQueries({ queryKey: keys.knowledge(boardId), exact: true });
}

export function useKnowledge(boardId: string | undefined) {
  return useQuery({
    queryKey: keys.knowledge(boardId ?? ''),
    queryFn: () => api.knowledge(boardId as string),
    enabled: Boolean(boardId),
  });
}

function applyFile(qc: QueryClient, f: KnowledgeFileView) {
  qc.setQueryData<BoardKnowledgeView>(keys.knowledge(f.boardId), (old) =>
    old ? { ...old, files: [f, ...old.files.filter((x) => x.id !== f.id)] } : old,
  );
}

/** A build reads up to 6 MB of files at a time, so big uploads can take more than one build. */
function buildNote(build: KnowledgeBuildView, added: KnowledgeFileView[]): string {
  const n = build.fileNames.length;
  const files = n === 1 ? build.fileNames[0] : `${n} files`;
  if (added.some((f) => !build.fileNames.includes(f.name))) return `Build #${build.number} is reading ${files} into the graph; the builds after it read the rest.`;
  return `Build #${build.number} is reading ${n !== added.length ? files : n === 1 ? 'it' : 'them'} into the graph.`;
}

/**
 * Uploads files one after the other (or a note, as a Markdown file), each with what the user says it
 * is, then asks the server to start a build when the board reads new files on its own.
 */
export function useUploadFiles(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (files: Array<{ name: string; data: Blob; description?: string }>) => {
      const id = toast.loading(files.length === 1 ? `Adding ${files[0]!.name}…` : `Adding ${files.length} files…`);
      const added: KnowledgeFileView[] = [];
      const failed: string[] = [];
      for (const [i, f] of files.entries()) {
        if (files.length > 1) toast.loading(`Adding ${i + 1} of ${files.length}: ${f.name}…`, { id });
        // The server would refuse it only after the whole upload, so it isn't sent.
        if (f.data.size > MAX_KNOWLEDGE_FILE_BYTES) {
          failed.push(`${f.name}: it is ${Math.ceil(f.data.size / 1024 / 1024)} MB, and files can be at most ${MAX_KNOWLEDGE_FILE_MB} MB.`);
          continue;
        }
        try {
          const view = await api.uploadContextFile(boardId, f.name, f.data, f.description);
          added.push(view);
          applyFile(qc, view);
        } catch (err) {
          failed.push(`${f.name}: ${errorMessage(err)}`);
        }
      }
      const { build } = added.length ? await api.autoBuildKnowledge(boardId).catch(() => ({ build: null })) : { build: null };
      toast.dismiss(id);
      return { added, failed, build };
    },
    onSuccess: ({ added, failed, build }) => {
      invalidateKnowledge(qc, boardId);
      if (failed.length) toast.error(`${failed.length} file${failed.length === 1 ? '' : 's'} not added`, { description: failed.join('\n') });
      if (added.length) {
        const what = added.length === 1 ? added[0]!.name : `${added.length} files`;
        toast.success(`Added ${what}`, { description: build ? buildNote(build, added) : undefined });
      }
    },
    onError: (err) => toast.error('Could not add the files', { description: errorMessage(err) }),
  });
}

/** Saves what the user says a file is; one read again starts a build when the board reads files on its own. */
export function useDescribeContextFile(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, description, reread }: { file: KnowledgeFileView; description: string; reread: boolean }) => {
      const view = await api.updateContextFile(file.id, { description, reread });
      const queued = view.status === 'pending' && file.status !== 'pending';
      const { build } = queued ? await api.autoBuildKnowledge(boardId).catch(() => ({ build: null })) : { build: null };
      return { view, queued, build };
    },
    onSuccess: ({ view, queued, build }) => {
      // In place: the list keeps its order.
      qc.setQueryData<BoardKnowledgeView>(keys.knowledge(boardId), (old) =>
        old ? { ...old, files: old.files.map((x) => (x.id === view.id ? view : x)) } : old,
      );
      invalidateKnowledge(qc, boardId);
      const what = view.description ? 'Description saved' : 'Description removed';
      if (build) toast.success(what, { description: `Build #${build.number} is reading ${view.name} again with it.` });
      else if (queued) toast.success(what, { description: `${view.name} is read again at the next build.` });
      else toast.success(what);
    },
    onError: (err) => toast.error('Could not save the description', { description: errorMessage(err) }),
  });
}

export function useRemoveContextFile(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (f: KnowledgeFileView) => api.removeContextFile(f.id),
    onMutate: (f) =>
      qc.setQueryData<BoardKnowledgeView>(keys.knowledge(boardId), (old) => (old ? { ...old, files: old.files.filter((x) => x.id !== f.id) } : old)),
    onSettled: () => invalidateKnowledge(qc, boardId),
    onError: (err) => toast.error('Could not remove the file', { description: errorMessage(err) }),
  });
}

export function useStartKnowledgeBuild(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fresh: boolean) => api.startKnowledgeBuild(boardId, fresh),
    onSuccess: (b) => {
      qc.setQueryData<BoardKnowledgeView>(keys.knowledge(boardId), (old) => (old ? { ...old, builds: [b, ...old.builds.filter((x) => x.id !== b.id)] } : old));
      invalidateKnowledge(qc, boardId);
    },
    onError: (err) => toast.error('Could not start the build', { description: errorMessage(err) }),
  });
}

export function useKnowledgePreview(boardId: string, q: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.knowledgePreview(boardId, q),
    queryFn: () => api.knowledgePreview(boardId, q),
    enabled,
    placeholderData: (prev) => prev,
  });
}
