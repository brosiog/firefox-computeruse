import { resolve } from 'node:path';

export default {
  build: {
    lib: { entry: resolve(import.meta.dirname, 'core-entry.ts'), formats: ['es'], fileName: () => 'core.mjs' },
    outDir: resolve(import.meta.dirname, '.build'),
    emptyOutDir: true,
    minify: false,
    target: 'node22',
  },
  logLevel: 'warn',
};
