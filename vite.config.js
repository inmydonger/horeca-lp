import { defineConfig } from 'vite';

// base './' keeps every asset path relative, so dist/ works from any folder or host.
export default defineConfig({
  base: './',
  build: { target: 'es2020', assetsInlineLimit: 0, chunkSizeWarningLimit: 800 },
});
