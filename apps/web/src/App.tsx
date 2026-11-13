import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { Toaster } from 'sonner';
import { useEventStream } from '@/api/stream';
import { useTitleBadge } from '@/api/titleBadge';
import { HealthBanner } from '@/components/layout/HealthBanner';
import { useTheme } from '@/lib/theme';
import { BoardPage } from '@/routes/BoardPage';
import { BoardsPage } from '@/routes/BoardsPage';
import { NotFoundPage } from '@/routes/NotFoundPage';

const SettingsPage = lazy(() => import('@/routes/SettingsPage').then((m) => ({ default: m.SettingsPage })));

export function App() {
  useEventStream();
  useTitleBadge();
  const { theme } = useTheme();

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <HealthBanner />
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<BoardsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/b/:boardSlug" element={<BoardPage />}>
              <Route path="t/:num" element={null} />
              {/* Other board views (Overview…); BoardPage reads the view from the path. */}
              <Route path=":view" element={null} />
              <Route path=":view/t/:num" element={null} />
              {/* One plan, inside the Plans view. */}
              <Route path="plans/:planId" element={null} />
              <Route path="plans/:planId/t/:num" element={null} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </div>
      <Toaster
        theme={theme}
        position="bottom-right"
        closeButton
        visibleToasts={5}
        toastOptions={{
          classNames: {
            toast: 'bg-popover! text-popover-foreground! border-border! shadow-lg! rounded-lg! text-[13px]!',
            description: 'text-muted-foreground! text-xs!',
            actionButton: 'bg-primary! text-primary-foreground! text-xs! font-medium!',
            closeButton: 'bg-popover! border-border! text-muted-foreground!',
          },
        }}
      />
    </div>
  );
}
