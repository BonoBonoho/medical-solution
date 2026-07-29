import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: true, environment: 'jsdom', include: ['test/**/*.test.ts?(x)'] },
  resolve: { alias: { '@': new URL('./src/', import.meta.url).pathname } },
});
