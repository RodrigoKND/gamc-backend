import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@config': r('./src/config'),
      '@shared': r('./src/shared'),
      '@infra': r('./src/infrastructure'),
      '@modules': r('./src/modules'),
    },
  },
});