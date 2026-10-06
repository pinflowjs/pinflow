import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// Compile-time constant (declared in src/globals.d.ts). Vitest skips this
// define — src/core/index.ts carries a `typeof` fallback for that runtime.
const define = { __PINFLOW_VERSION__: JSON.stringify(pkg.version) };

// Private class members follow a `_` prefix convention (Annotator,
// GestureController, TranscriptStore) so the minifier can shorten them.
// Anything crossing a module contract (VoiceHost/VoiceSession, Handle,
// Storage, DOM APIs) is unprefixed and therefore never mangled.
const MANGLE_PRIVATE = /^_/;

export default defineConfig([
  {
    entry: {
      index: 'src/core/index.ts',
      capture: 'src/capture/index.ts',
      handoff: 'src/handoff/index.ts',
      voice: 'src/voice/index.ts',
      verification: 'src/verification/index.ts',
      instrumentation: 'src/instrumentation/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: true,
    define,
    // One file per entry — avoids emitting shared `chunk-*.js` files that
    // would show up alongside the published package on unpkg/jsdelivr.
    splitting: false,
    // Keep the lazy `import('pinflowjs/voice')` a runtime reference so voice code
    // is never pulled into the core graph (the "0 bytes for text users" rule).
    external: ['pinflowjs/voice'],
    esbuildOptions(options) {
      options.external = [...(options.external ?? []), 'pinflowjs/voice'];
      options.mangleProps = MANGLE_PRIVATE;
    },
    target: 'es2020',
    outDir: 'dist',
  },
  {
    entry: { pinflow: 'src/core/iife.ts' },
    format: ['iife'],
    // The other two configs already treeshake; this entry was the sole omission.
    // Because `pinflowjs/voice` is an external DYNAMIC import in iife
    // format, esbuild emits its `__require`/`__toESM` CJS-interop preamble
    // unconditionally — dead here, and rollup's post-pass is what drops it.
    // NEVER `'smallest'`: that preset sets `propertyReadSideEffects: false`,
    // licensing rollup to delete the layout-forcing `.offsetHeight`/
    // `.offsetWidth` reads in `annotator.ts` that exist to flush style.
    treeshake: true,
    globalName: 'Pinflow',
    minify: true,
    sourcemap: true,
    define,
    external: ['pinflowjs/voice'],
    esbuildOptions(options) {
      options.external = [...(options.external ?? []), 'pinflowjs/voice'];
      options.mangleProps = MANGLE_PRIVATE;
    },
    target: 'es2020',
    outDir: 'dist',
    outExtension: () => ({ js: '.iife.js' }),
  },
  {
    // React/Vue wrappers must NOT bundle a copy of core: they import the bare
    // `pinflow` specifier, resolved via this package's own `exports` map by the
    // consumer's bundler (wrapper consumers by definition run bundlers).
    // Inlining core here would ship a second copy with its own independent
    // `init()` singleton whenever an app also imports `pinflow` directly.
    // Wrappers and core therefore ship in lockstep versions.
    entry: {
      react: 'src/react/index.ts',
      vue: 'src/vue/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    treeshake: true,
    minify: true,
    define,
    splitting: false,
    external: ['pinflowjs', 'react', 'vue'],
    esbuildOptions(options) {
      options.mangleProps = MANGLE_PRIVATE;
    },
    target: 'es2020',
    outDir: 'dist',
  },
]);
