import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  build: { outDir: '../../dist/web', emptyOutDir: true, target: 'es2022' },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8080', '/auth': 'http://127.0.0.1:8080', '/ingest': 'http://127.0.0.1:8080' } },
});
