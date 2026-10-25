import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  build: {
    rollupOptions: {
      // test.html is the hook for scripts/browsertest.mjs (npm test)
      input: mode === 'test' ? ['index.html', 'test.html'] : ['index.html'],
    },
  },
  resolve: {
    alias: {
      // Built by `make wasm` in ../engine
      '@engine': fileURLToPath(new URL('../build/wasm', import.meta.url)),
    },
  },
  worker: {
    // Audio worklets are loaded as ES modules
    format: 'es',
  },
  server: {
    fs: { allow: ['..'] },
  },
}));
