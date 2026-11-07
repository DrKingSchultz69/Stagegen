import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const core = process.env.STAGEGEN_CORE ?? 'http://127.0.0.1:8080';

// Dev: `npm run dev` serves the UI with hot reload and proxies API/WebSocket to stagegen-core.
// Prod: `npm run build` writes web/dist, which stagegen-core serves directly.
export default defineConfig({
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        studio: fileURLToPath(new URL('./index.html', import.meta.url)),
        show: fileURLToPath(new URL('./show.html', import.meta.url)),
      },
    },
  },
  server: {
    host: true,
    proxy: {
      '/api': core,
      '/media': core,
      '/ws': { target: core.replace(/^http/, 'ws'), ws: true },
    },
  },
  plugins: [
    {
      name: 'stagegen-show-route',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url?.startsWith('/show/')) req.url = '/show.html';
          next();
        });
      },
    },
  ],
});
