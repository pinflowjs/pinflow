import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

// The packed surface is what consumers actually get: compile a consumer
// program against dist/index.d.ts and require zero diagnostics (review #24).
// Gated like bundle-isolation: CI builds first and must not skip.
const DTS = resolve('dist/index.d.ts');

describe('packed package type surface', () => {
  it.runIf(Boolean(process.env['CI']))('CI must run against built types', () => {
    expect(existsSync(DTS), 'dist/index.d.ts missing in CI: build before testing').toBe(true);
  });

  it.runIf(existsSync(DTS))('a consumer can import and use the public types', () => {
    const consumer = `
      import { init, routeOf, exportReviewer, version } from './dist/index';
      import type { PinflowTheme, PinflowConfig, Comment, Handle, AreaPercent } from './dist/index';
      import { createVerification, feedbackRevision } from './dist/verification';
      import { pinflowSource } from './dist/instrumentation';
      import { init as initCapture } from './dist/capture';
      import { prepareHandoff } from './dist/handoff';
      const capture = initCapture({ project: 'capture', expectedOutcome: true });
      const artifact = prepareHandoff(capture.getSnapshot());
      const markdown: string = artifact.markdown;
      const share: Promise<'shared' | 'cancelled' | 'unavailable'> = artifact.share();
      // @ts-expect-error Capture hosts use the optional handoff adapter.
      capture.exportMarkdown();
      // @ts-expect-error Builder aggregation remains in the full entry.
      initCapture({ project: 'capture', mode: 'builder' });
      export { markdown, share };
      import type { FeedbackContext, CapturePoint, CaptureDetails, TargetResolution } from './dist/index';
      const point: CapturePoint = {clientX: 10, clientY: 20};
      const details: CaptureDetails = {state: ['checked=true']};
      const resolution: TargetResolution = {availability: 'matched', rung: 'id', owner: 'agrees'};
      export { point, details, resolution };
      const evidence: FeedbackContext = {expected: 'Checkout opens'};
      export { createVerification, feedbackRevision, pinflowSource, evidence };
      const theme: PinflowTheme = { accent: '#123456', radius: '8px' };
      const area: AreaPercent = { x: 10, y: 20, w: 30, h: 40 };
      export { area };
      const config: PinflowConfig = {
        project: 'p',
        theme,
        exportUi: 'auto',
        describeRoute: (k: string) => k,
        captureContext: (target, point) => ({subject: target.tagName + point.clientX, intent: 'instance'}),
      };
      const handle: Handle = init(config);
      const md: string = handle.exportMarkdown();
      const r: string = routeOf('https://x/a?reviewer=b');
      const v: string = version;
      export { md, r, v, exportReviewer };
      export type { Comment };
    `;
    const host = ts.createCompilerHost({});
    const orig = host.readFile.bind(host);
    host.readFile = (f: string) => (f.endsWith('__consumer__.ts') ? consumer : orig(f));
    const program = ts.createProgram(
      ['__consumer__.ts'],
      {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
        paths: { './dist/index': [DTS] },
        baseUrl: '.',
      },
      host,
    );
    const diags = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diags).toEqual([]);
  });
});
