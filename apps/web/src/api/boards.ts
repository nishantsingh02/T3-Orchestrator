import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardView, CreateBoardBody, PatchBoardBody } from '@t3-orchestra/shared';
import { toast } from 'sonner';
import { applyBoard } from './cache';
import { api, errorMessage } from './client';
import { keys } from './keys';

export function useBoards() {
  return useQuery({ queryKey: keys.boards, queryFn: api.boards });
}

/** A board by id or slug. Seeds from the boards list so navigation renders instantly. */
export function useBoard(idOrSlug: string | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: keys.board(idOrSlug ?? ''),
    queryFn: async () => {
      const board = await api.board(idOrSlug as string);
      qc.setQueryData(keys.board(board.id), board);
      return board;
    },
    enabled: Boolean(idOrSlug),
    placeholderData: () =>
      qc.getQueryData<BoardView[]>(keys.boards)?.find((b) => b.slug === idOrSlug || b.id === idOrSlug),
  });
}

/** Run and wait statistics for the Overview; the caller refetches it when tasks change stage. */
export function useBoardStats(boardId: string | undefined) {
  return useQuery({
    queryKey: keys.stats(boardId ?? ''),
    queryFn: () => api.boardStats(boardId as string),
    enabled: Boolean(boardId),
    placeholderData: (prev) => prev,
  });
}

export function useCreateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBoardBody) => api.createBoard(body),
    onSuccess: (board) => {
      qc.setQueryData<BoardView[]>(keys.boards, (old) => (old ? [...old, board] : old));
      applyBoard(qc, board);
    },
  });
}

/** PATCH a board, optimistically. Pass the current board so the cache can be updated in place. */
export function usePatchBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ board, patch }: { board: BoardView; patch: PatchBoardBody }) => api.patchBoard(board.id, patch),
    onMutate: ({ board, patch }) => {
      applyBoard(qc, { ...board, ...patch } as BoardView);
      return { prev: board };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) applyBoard(qc, ctx.prev);
      toast.error('Could not update the board', { description: errorMessage(err) });
    },
    onSuccess: (board) => applyBoard(qc, board),
  });
}

export function useArchiveBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (board: BoardView) => api.archiveBoard(board.id),
    onSuccess: (_res, board) => {
      qc.setQueryData<BoardView[]>(keys.boards, (old) => old?.filter((b) => b.id !== board.id));
      qc.removeQueries({ queryKey: keys.board(board.id) });
      qc.removeQueries({ queryKey: keys.board(board.slug) });
    },
    onError: (err) => toast.error('Could not archive the board', { description: errorMessage(err) }),
  });
}

export function useValidateProject() {
  return useMutation({ mutationFn: api.validateProject });
}

export function useAddToT3() {
  return useMutation({ mutationFn: api.addToT3 });
}

/** Browse…: the OS's folder window. Resolves with null when the user closes it without choosing. */
export function usePickFolder() {
  return useMutation({ mutationFn: api.pickFolder });
}

export function useCheckNewFolder() {
  return useMutation({ mutationFn: api.checkNewFolder });
}

/** Who `gh` is signed in as, for "Create a private GitHub repo". */
export function useGithubAccount(enabled: boolean) {
  return useQuery({ queryKey: keys.githubAccount, queryFn: () => api.githubAccount(), enabled, staleTime: 60_000, retry: false });
}

/** Asks gh again, past the server's one-minute cache (after the user ran `gh auth login`). */
export function useRecheckGithub() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => api.githubAccount(true), onSuccess: (account) => qc.setQueryData(keys.githubAccount, account) });
}

/** Makes the folder, sets up git and GitHub, and adds the project to T3 Code (each step only when asked). */
export function useSetupProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.setupProject,
    onSettled: () => qc.invalidateQueries({ queryKey: keys.t3Projects }),
  });
}

/** The projects T3 Code knows, for "Import from T3 Code". */
export function useT3Projects(enabled = true) {
  return useQuery({ queryKey: keys.t3Projects, queryFn: api.t3Projects, enabled, staleTime: 15_000, retry: false });
}

/** Starts (or repeats) an import: an agent reads the project's T3 threads and writes the project context. */
export function useImportFromT3() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (board: BoardView) => api.importFromT3(board.id),
    onSuccess: (board) => applyBoard(qc, board),
    onError: (err) => toast.error('Could not start the import', { description: errorMessage(err) }),
  });
}

export function useBoardProjectCheck(boardId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['board-validate', boardId],
    queryFn: () => api.validateBoardProject(boardId),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}
