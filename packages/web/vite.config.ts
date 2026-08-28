import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 4318,
    // The API lives on the server process; in dev we proxy so the app is
    // same-origin in development exactly as it is in production.
    proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    // three.js is the bulk of the bundle and only the dashboard needs it.
    rollupOptions: { output: { manualChunks: { three: ['three'] } } },
    chunkSizeWarningLimit: 900,
  },
});
