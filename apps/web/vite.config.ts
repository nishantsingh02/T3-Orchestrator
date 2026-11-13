import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = 'http://127.0.0.1:4417';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        // The server rejects any Host other than 127.0.0.1/localhost:4417 (DNS-rebinding guard).
        changeOrigin: true,
        configure(proxy) {
          // Keep SSE unbuffered: no compression negotiation, and flush headers immediately.
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.url?.startsWith('/api/stream')) proxyReq.setHeader('accept-encoding', 'identity');
          });
          // When the server dies mid-response (e.g. a --watch restart), the proxy leaves the browser's
          // side open forever, so the SSE stream goes silent and EventSource never reconnects. Cut it.
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            proxyRes.on('close', () => {
              if (!proxyRes.complete) res.destroy();
            });
          });
        },
      },
    },
  },
  preview: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    // Served from localhost by the T3 Orchestra server; a large vendor chunk is fine.
    chunkSizeWarningLimit: 1000,
  },
});
