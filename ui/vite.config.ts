import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In development the UI runs on Vite's dev server and proxies API traffic to
 * the agent server, so both halves reload independently. In production the
 * server serves ui/dist directly, making the whole thing one process.
 */
const SERVER_PORT = process.env.AGENTZERO_PORT ?? '4319';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.AGENTZERO_UI_PORT ?? 5319),
    fs: {
      // The UI imports its wire types from server/src/shared/types.ts
      // (type-only, erased at build time), so Vite may read one level up.
      allow: ['..'],
    },
    proxy: {
      '/api': {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
        // The event stream must not be buffered by the proxy.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
