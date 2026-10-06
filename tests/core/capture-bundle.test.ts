import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsup'))('esbuild');

describe('capture package boundary', () => {
  it('has no runtime import edge to handoff, serializers, download or full UI', async () => {
    const result = await build({
      entryPoints: ['src/capture/index.ts'],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'browser',
      format: 'esm',
      external: ['pinflowjs/voice'],
    });
    const inputs = Object.keys(result.metafile.inputs);
    for (const excluded of [
      'src/core/export.ts',
      'src/core/download.ts',
      'src/core/ui/annotator.ts',
      'src/handoff/index.ts',
      'src/core/ui/dom.ts',
    ]) {
      expect(inputs, excluded).not.toContain(excluded);
    }
    expect(inputs).toContain('src/core/capture.ts');
    expect(inputs).toContain('src/core/scope.ts');
    expect(inputs).toContain('src/core/storage.ts');
  });

  it.runIf(Boolean(process.env['CI']))('CI tests both new packed entries', () => {
    for (const name of ['capture', 'handoff'])
      for (const ext of ['js', 'cjs', 'd.ts']) expect(existsSync(`dist/${name}.${ext}`)).toBe(true);
  });

  it.runIf(existsSync('dist/capture.js'))(
    'the built capture entry excludes handoff UI and voice implementation',
    () => {
      for (const ext of ['js', 'cjs']) {
        const code = readFileSync(`dist/capture.${ext}`, 'utf8');
        expect(code).not.toMatch(
          /Download Feedback Markdown|Your feedback is ready|How to read this file|navigator\.share|clipboard|createObjectURL|getUserMedia|AudioWorklet|\.panel\{position/,
        );
        expect(code).toContain('pinflowjs/voice');
      }
    },
  );
});
