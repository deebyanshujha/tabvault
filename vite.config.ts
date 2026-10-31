import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Three HTML pages plus the service worker. The worker must keep a stable,
// unhashed filename because manifest.json points at it directly.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome121',
    sourcemap: mode === 'development',
    minify: mode !== 'development',
    modulePreload: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'popup.html'),
        dashboard: resolve(import.meta.dirname, 'dashboard.html'),
        sidepanel: resolve(import.meta.dirname, 'sidepanel.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/unit/setup.ts'],
    restoreMocks: true,
  },
}));
