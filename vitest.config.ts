import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The lazy `import('pinflowjs/voice')` self-reference can't resolve in the
      // test runtime (no built dist) — point it at the source so import-analysis
      // is satisfied. The import stays lazy; only voice-activation tests run it.
      'pinflowjs/voice': fileURLToPath(new URL('./src/voice/index.ts', import.meta.url)),
      // Bare self-reference used by the react/vue wrappers (kept external in
      // the build — see tsup.config.ts). Must stay AFTER 'pinflowjs/voice':
      // aliases match in order and a bare 'pinflowjs' entry also
      // matches 'pinflowjs/voice' as a prefix.
      pinflowjs: fileURLToPath(new URL('./src/core/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Defensive, not a fix: the includes above are root-anchored, so nested
    // worktrees are already missed. This only matters if someone broadens
    // them to `**/*.test.ts`, at which point a stale .claude/worktrees
    // checkout would double every suite in it.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/worktrees/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/core/**/*.ts', 'src/capture/**/*.ts', 'src/handoff/**/*.ts'],
      exclude: [
        'src/core/iife.ts',
        'src/core/types.ts',
        'src/core/voice-contract.ts',
        'src/core/voice-loader.ts',
        '**/*.d.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
