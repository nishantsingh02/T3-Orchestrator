import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppSettings, HealthView, PatchSettings } from '@t3-orchestra/shared';
import { toast } from 'sonner';
import { api, errorMessage } from './client';
import { keys } from './keys';

export function useHealth() {
  return useQuery({ queryKey: keys.health, queryFn: api.health, staleTime: Infinity, retry: false });
}

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: api.settings, staleTime: 60_000 });
}

export function useSettingsInfo() {
  return useQuery({ queryKey: keys.settingsInfo, queryFn: api.settingsInfo, staleTime: 60_000 });
}

/** Providers enabled in T3 Code and their models (the server caches it for a minute too). */
export function useT3Models() {
  return useQuery({ queryKey: keys.t3Models, queryFn: api.t3Models, staleTime: 60_000, retry: false });
}

function mergeSettings(old: AppSettings, patch: PatchSettings): AppSettings {
  return {
    ...old,
    ...patch,
    notifications: { ...old.notifications, ...patch.notifications },
    boardDefaults: { ...old.boardDefaults, ...patch.boardDefaults },
  };
}

/** PATCH /api/settings with an optimistic deep merge (notifications, boardDefaults). */
export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: PatchSettings) => api.patchSettings(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: keys.settings, exact: true });
      const prev = qc.getQueryData<AppSettings>(keys.settings);
      if (prev) qc.setQueryData(keys.settings, mergeSettings(prev, patch));
      return { prev };
    },
    onError: (err, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.settings, ctx.prev);
      toast.error('Could not save settings', { description: errorMessage(err) });
    },
    onSuccess: (settings) => qc.setQueryData(keys.settings, settings),
  });
}

export function useTestConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.testConnection,
    onSuccess: (health: HealthView) => {
      qc.setQueryData(keys.health, health);
      if (health.cliFound && health.serverReachable) {
        toast.success('Connected to T3 Code', { description: health.version ? `Version ${health.version}` : undefined });
      } else {
        toast.error('T3 Code is not reachable', {
          description: health.error ?? (health.cliFound ? 'The T3 server is not running.' : 'The t3 CLI was not found.'),
        });
      }
    },
    onError: (err) => toast.error('Connection test failed', { description: errorMessage(err) }),
  });
}

export function useOpenPromptsDir() {
  return useMutation({
    mutationFn: api.openPromptsDir,
    onError: (err) => toast.error('Could not open the folder', { description: errorMessage(err) }),
  });
}
