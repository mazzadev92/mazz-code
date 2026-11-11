/// <reference types="vitest/config" />
import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const DEV_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

/** Another site open in the browser must not reach the Studio through this proxy: foreign origins get 403. */
function sameOriginOnly(proxy: Parameters<NonNullable<ProxyOptions['configure']>>[0]): void {
  proxy.on('proxyReq', (proxyReq, req, res) => {
    const origin = req.headers.origin;
    if (origin && !DEV_ORIGINS.includes(origin)) {
      res.writeHead(403);
      res.end();
      proxyReq.destroy();
      return;
    }
    proxyReq.removeHeader('origin');
  });
}

// The Studio server (port 3333) serves the built files; `npm run dev` proxies /api to it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Pure types and formulas shared with the backend (no Node APIs).
      '@mazz/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // The Studio server accepts no foreign origin: the dev proxy presents its requests as same-origin.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3333', changeOrigin: true, configure: sameOriginOnly },
      '/sandbox': { target: 'http://127.0.0.1:3333', changeOrigin: true, configure: sameOriginOnly },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Languages stay out of the editor chunk: each one is fetched on demand (Editor.tsx imports them dynamically).
          if (/@codemirror\/lang-|@lezer\/(javascript|python|cpp|json|markdown|rust|html|css|xml|lr|yaml)/.test(id)) return undefined;
          if (id.includes('@codemirror') || id.includes('@lezer') || id.includes('codemirror')) return 'editor';
          if (id.includes('highlight.js')) return 'highlight';
          if (id.includes('node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    fileParallelism: false,
  },
});
