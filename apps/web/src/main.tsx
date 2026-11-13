import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { isApiError } from '@/api/client';
import { ConfirmProvider } from '@/components/ui/confirm';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/lib/theme';
import { App } from './App';
import './styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live updates arrive over SSE; never poll, and don't refetch just because the tab regained focus.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: (count, err) => {
        if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
        return count < 2;
      },
    },
    mutations: { retry: false },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={350} skipDelayDuration={150}>
          <BrowserRouter>
            <ConfirmProvider>
              <App />
            </ConfirmProvider>
          </BrowserRouter>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
