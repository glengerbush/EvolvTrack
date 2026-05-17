import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// Default environment is `node` so pure-logic tests stay fast. Tests that
// actually touch `window` / `document` / `navigator` / `URL.createObjectURL`
// must opt in with `// @vitest-environment happy-dom` at the top of the file.
// `src/test/setup.ts` provides an in-memory Storage shim in both environments
// (Node 25 ships a broken built-in `localStorage` stub we have to override).
export default defineConfig({
  plugins: [sveltekit()],
  // Pick Svelte's browser entry so `mount()` is available in component tests
  // (the default Node resolution returns the server build, which throws).
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  test: {
    environment: 'node',
    globals: false,
    restoreMocks: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Measure every source file, even ones no test imports — otherwise the
      // headline % only reflects "files we happened to touch".
      all: true,
      include: ['src/**/*.{ts,svelte}'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/test/**',
        'src/routes/**',
        'src/app.d.ts',
      ],
    },
  },
});
