/**
 * Vitest configuration — separate from vite.config.ts to keep the dev-server
 * config unchanged (fullstack-js rule: do NOT modify Vite setup).
 *
 * Environment:  jsdom  — required for React component tests and window/document APIs
 * Coverage:     v8     — native Node.js V8 coverage (no babel transform needed)
 * Setup files:  run @testing-library/jest-dom matchers before every suite
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

const cwd = process.cwd();

export default defineConfig({
  plugins: [react()],
  test: {
    // Default to jsdom for React component tests.
    // Server tests declare their environment via the
    //   // @vitest-environment node
    // docblock at the top of the file.
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./client/src/test/setup.ts'],
    include: [
      'client/src/**/*.{test,spec}.{ts,tsx}',
      'server/**/*.{test,spec}.{ts,tsx}',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'client/src/utils/**',
        'client/src/components/**',
        'server/index.ts',
      ],
    },
    // Alias resolution must mirror vite.config.ts so imports work in tests
    alias: {
      '@': path.resolve(cwd, 'client/src'),
      '@assets': path.resolve(cwd, 'attached_assets'),
      '@shared': path.resolve(cwd, 'shared'),
      '@lib': path.resolve(cwd, 'client/src/lib'),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(cwd, 'client/src'),
      '@assets': path.resolve(cwd, 'attached_assets'),
      '@shared': path.resolve(cwd, 'shared'),
      '@lib': path.resolve(cwd, 'client/src/lib'),
    },
  },
});
