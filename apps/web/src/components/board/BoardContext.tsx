import type { BoardView, MilestoneView, TaskView } from '@t3-orchestra/shared';
import { createContext, useContext } from 'react';
import type { useTaskActions } from '@/components/tasks/useTaskActions';

export type DrawerTab = 'overview' | 'activity' | 'review';

/** One page of a task's design options. */
export interface DesignOptionRef {
  round: number;
  file: string;
}

/** The board's views; every one but 'board' (the Kanban) has its own path segment, /b/:slug/<view>. */
export const BOARD_MODES = ['board', 'plans', 'overview', 'roadmap', 'insights', 'ideas', 'marketing', 'security', 'context'] as const;
export type BoardMode = (typeof BOARD_MODES)[number];

export function boardModeFrom(segment: string | undefined): BoardMode {
  return BOARD_MODES.find((m) => m !== 'board' && m === segment) ?? 'board';
}

/** Base path of a board view: /b/:slug or /b/:slug/<view>. */
export function boardModePath(slug: string, mode: BoardMode): string {
  return mode === 'board' ? `/b/${slug}` : `/b/${slug}/${mode}`;
}

export interface BoardContextValue {
  board: BoardView;
  tasks: TaskView[];
  /** Tasks currently holding a slot (implementing + ai_review). */
  activeTasks: TaskView[];
  activeCount: number;
  pauseAll: boolean;
  /** The board's milestones in order. */
  milestones: MilestoneView[];
  openTask: (task: TaskView, tab?: DrawerTab) => void;
  /** Opens the task's design options full screen, optionally at one option. */
  openDesigns: (task: TaskView, at?: DesignOptionRef) => void;
  /** Opens the plan composer, optionally with a prepared prompt. */
  openPlanComposer: (prompt?: string) => void;
  run: ReturnType<typeof useTaskActions>['run'];
  runMany: ReturnType<typeof useTaskActions>['runMany'];
}

export const BoardContext = createContext<BoardContextValue | null>(null);

/** The board context when inside a board (cards and dialogs are also used elsewhere). */
export function useOptionalBoardContext(): BoardContextValue | null {
  return useContext(BoardContext);
}

/** "M2" for a milestone. */
export const milestoneKey = (m: Pick<MilestoneView, 'number'>) => `M${m.number}`;

export function useBoardContext(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error('useBoardContext must be used inside a board');
  return ctx;
}
